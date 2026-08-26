import mongoose from 'mongoose';
import { FoodOrder } from '../models/order.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import {
    loadRestaurantForOrdering,
    assertRestaurantOpenForOrdering,
    getDeliveryDistanceKm,
    loadActiveFeeSettings,
    resolveUserDeliveryFee,
    computeDeliveryFeeGst,
    calculateRiderEarning,
    estimateDeliveryPromiseMinutes,
} from './order-pricing.service.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';
import { findZoneForPoint, readAddressPoint } from '../../shared/zoneServiceability.js';
import { buildOrderPrescription, PRESCRIPTION_STATUS } from '../../shared/prescriptionRules.js';
import {
    assertFillable,
    assertSellerDispensesMedicine,
    computeQuoteSubtotal,
    normalizeQuoteItems,
} from '../../shared/prescriptionOrder.js';
import {
    buildOrderIdentityFilter,
    enqueueOrderEvent,
    notifyOwnerSafely,
    notifyRestaurantNewOrder,
    pushStatusHistory,
    sanitizeOrderForExternal,
} from './order.helpers.js';

/**
 * Prescription-only orders: placed from a photograph, priced by the pharmacist.
 *
 * Kept out of order.service.js deliberately. That file builds an order from
 * catalogue lines — resolving products, reserving stock, applying coupons,
 * taking payment — and none of it applies to an order whose contents are not
 * known yet. Threading a "no items" mode through it would put a branch in every
 * one of those steps; this is the same document written by a shorter path, and
 * it rejoins the ordinary lifecycle the moment the pharmacist prices it.
 */

const toObjectId = (value, label) => {
    const raw = String(value || '');
    if (!mongoose.Types.ObjectId.isValid(raw)) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(raw);
};

/** Zero pricing: nothing is known until the pharmacist reads the prescription. */
const emptyPricing = () => ({
    subtotal: 0,
    tax: 0,
    packagingFee: 0,
    deliveryFee: 0,
    deliveryFeeGst: 0,
    platformFee: 0,
    quickDeliveryFee: 0,
    deliveryMode: 'basic',
    restaurantCommission: 0,
    discount: 0,
    couponCode: null,
    total: 0,
    currency: 'INR',
    distanceKm: null,
});

/**
 * A prescription order is always cash on delivery.
 *
 * There is no total at placement, so there is nothing to charge — and asking the
 * customer to pay again after the pharmacist prices it would mean an order that
 * can be abandoned after the medicine has already been set aside.
 */
const codPayment = () => ({
    method: 'cash',
    status: 'cod_pending',
});

const emitToCustomer = (order, event, payload) => {
    try {
        const io = getIO();
        if (!io) return;
        io.to(rooms.user(String(order.userId))).emit(event, payload);
        io.to(rooms.tracking(String(order._id))).emit(event, payload);
    } catch (err) {
        logger.warn(`prescription order socket emit failed: ${err?.message || err}`);
    }
};

/**
 * Place an order from a photographed prescription.
 *
 * @param {string} userId
 * @param {{restaurantId: string, address: object, prescriptionImage: string, note?: string, customerName?: string, customerPhone?: string}} dto
 */
export async function createPrescriptionOrder(userId, dto = {}) {
    const restaurantId = toObjectId(dto.restaurantId, 'Restaurant ID');
    const restaurant = await loadRestaurantForOrdering(restaurantId);

    // Only a pharmacy may take one of these, and only while it is open — the same
    // two gates an ordinary order passes, asked before anything is written.
    assertSellerDispensesMedicine(restaurant);
    const orderAt = new Date();
    assertRestaurantOpenForOrdering(restaurant, orderAt);

    const deliveryAddress = normalizeDeliveryAddress({
        label: dto.address?.label || 'Home',
        name: dto.address?.name || dto.address?.fullName || dto.customerName || '',
        fullName: dto.address?.fullName || dto.address?.name || dto.customerName || '',
        street: dto.address?.street || '',
        additionalDetails: dto.address?.additionalDetails || '',
        city: dto.address?.city || '',
        state: dto.address?.state || '',
        zipCode: dto.address?.zipCode || '',
        phone: dto.address?.phone || '',
        ...(dto.address || {}),
    });

    const point = readAddressPoint(deliveryAddress);
    if (!point) {
        throw new ValidationError('This address has no location saved. Please re-select it on the map.');
    }

    const zone = await findZoneForPoint(point.lat, point.lng);
    if (!zone) throw new ValidationError("We don't deliver to this address yet");
    const sellerZoneId = restaurant?.zoneId ? String(restaurant.zoneId) : '';
    if (sellerZoneId && sellerZoneId !== String(zone._id)) {
        throw new ValidationError('This store does not deliver to the selected address');
    }

    // buildOrderPrescription is the same rule the catalogue path uses, so a
    // medical order can never exist without a prescription no matter which way in
    // it took. It throws when the image is missing.
    const prescription = buildOrderPrescription(restaurant, dto, orderAt);

    const order = new FoodOrder({
        userId: toObjectId(userId, 'User ID'),
        restaurantId,
        zoneId: zone._id,
        prescriptionOnly: true,
        prescription,
        items: [],
        deliveryAddress,
        customerName: String(dto.customerName || deliveryAddress.fullName || ''),
        customerPhone: String(dto.customerPhone || deliveryAddress.phone || ''),
        pricing: emptyPricing(),
        payment: codPayment(),
        orderStatus: 'created',
        note: String(dto.note || '').slice(0, 500),
    });

    pushStatusHistory(order, {
        byRole: 'USER',
        byId: userId,
        from: '',
        to: 'created',
        note: 'Prescription uploaded',
    });

    await order.save();

    // The pharmacist has to be told, or the order sits unread: there is no
    // catalogue notification path for an order with no items.
    notifyRestaurantNewOrder(order).catch((err) =>
        logger.warn(`prescription order seller notify failed: ${err?.message || err}`),
    );

    enqueueOrderEvent('prescription_order_created', {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        restaurantId: String(restaurantId),
        userId: String(userId),
    });

    return sanitizeOrderForExternal(order);
}

/**
 * The pharmacist enters what they will dispense, and the order gets a price.
 *
 * Delivery fee, its GST and the rider's earning are computed the same way the
 * catalogue path computes them, from the same fee settings — a prescription
 * order costs the platform exactly what any other order of that distance does.
 */
export async function fillPrescriptionOrder(orderId, restaurantId, dto = {}) {
    const identity = buildOrderIdentityFilter(orderId);
    if (!identity) throw new ValidationError('Order id required');

    const order = await FoodOrder.findOne({
        ...identity,
        restaurantId: new mongoose.Types.ObjectId(restaurantId),
    });
    if (!order) throw new NotFoundError('Order not found');

    assertFillable(order);

    // Pricing an order whose prescription was rejected would be busywork: it can
    // only be cancelled from here.
    if (order.prescription?.status === PRESCRIPTION_STATUS.REJECTED) {
        throw new ValidationError('The prescription on this order was rejected, so it cannot be priced.');
    }

    const items = normalizeQuoteItems(dto.items);
    const subtotal = computeQuoteSubtotal(items);

    const restaurant = await loadRestaurantForOrdering(order.restaurantId);
    const distanceKm = await getDeliveryDistanceKm(restaurant, order.deliveryAddress);
    const feeSettings = await loadActiveFeeSettings();

    const deliveryFee = resolveUserDeliveryFee(feeSettings, { subtotal, distanceKm });
    const deliveryFeeGst = computeDeliveryFeeGst(deliveryFee);
    const platformFee = Number(feeSettings?.platformFee) || 0;
    const total = Math.round((subtotal + deliveryFee + deliveryFeeGst + platformFee) * 100) / 100;

    order.items = items;
    order.pricing = {
        ...emptyPricing(),
        subtotal,
        deliveryFee,
        deliveryFeeGst,
        platformFee,
        total,
        distanceKm: Number.isFinite(distanceKm) ? distanceKm : null,
    };
    order.riderEarning = calculateRiderEarning(feeSettings, distanceKm);

    const promiseMinutes = estimateDeliveryPromiseMinutes(distanceKm);
    if (Number.isFinite(promiseMinutes)) {
        order.deliveryPromiseMinutes = promiseMinutes;
    }

    pushStatusHistory(order, {
        byRole: 'RESTAURANT',
        byId: restaurantId,
        from: order.orderStatus,
        to: order.orderStatus,
        note: `Priced: ${items.length} item(s), ₹${total}`,
    });

    await order.save();

    const payload = sanitizeOrderForExternal(order);

    // The customer's screen is showing "waiting for the pharmacy" — this is what
    // moves it on, so it is pushed rather than waited for on the next poll.
    emitToCustomer(order, 'order_status_update', payload);
    notifyOwnerSafely(
        { ownerType: 'USER', ownerId: String(order.userId) },
        {
            title: 'Your medicines are priced',
            body: `${restaurant?.restaurantName || 'The pharmacy'} has priced your prescription — ₹${total}.`,
            data: {
                type: 'prescription_order_priced',
                orderId: String(order._id),
                total: String(total),
            },
        },
    ).catch(() => {});

    enqueueOrderEvent('prescription_order_priced', {
        orderMongoId: order._id?.toString?.(),
        orderId: order._id.toString(),
        restaurantId: String(restaurantId),
        total,
    });

    return payload;
}
