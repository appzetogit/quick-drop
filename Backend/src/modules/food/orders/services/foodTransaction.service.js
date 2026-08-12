import { FoodTransaction } from '../models/foodTransaction.model.js';
import { FoodRestaurantCommission } from '../../admin/models/restaurantCommission.model.js';
import mongoose from 'mongoose';

const RESTAURANT_COMMISSION_CACHE_MS = 60 * 1000;
let restaurantCommissionRulesCache = null;
let restaurantCommissionRulesLoadedAt = 0;

async function getActiveRestaurantCommissionRules() {
  const now = Date.now();
  if (
    restaurantCommissionRulesCache &&
    now - restaurantCommissionRulesLoadedAt < RESTAURANT_COMMISSION_CACHE_MS
  ) {
    return restaurantCommissionRulesCache;
  }

  const list = await FoodRestaurantCommission.find({
    status: { $ne: false },
  }).lean();
  restaurantCommissionRulesCache = list || [];
  restaurantCommissionRulesLoadedAt = now;
  return restaurantCommissionRulesCache;
}

export function computeRestaurantCommissionAmount(baseAmount, rule) {
  const safeBase = Math.max(0, Number(baseAmount) || 0);
  if (!Number.isFinite(safeBase) || safeBase < 0) return 0;

  const commissionType = rule?.defaultCommission?.type || 'percentage';
  const commissionValue = Math.max(
    0,
    Number(rule?.defaultCommission?.value ?? 0) || 0
  );

  let commissionAmount = 0;
  if (commissionType === 'percentage') {
    commissionAmount = safeBase * (commissionValue / 100);
  } else if (commissionType === 'amount') {
    commissionAmount = commissionValue;
  }

  // Round to 2 decimals and clamp to [0, base]
  commissionAmount = Math.round((commissionAmount || 0) * 100) / 100;
  commissionAmount = Math.max(0, Math.min(commissionAmount, safeBase));

  return { commissionAmount, commissionType, commissionValue, baseAmount: safeBase };
}

export async function getRestaurantCommissionSnapshot(orderDoc) {
  const baseAmount = Number(orderDoc?.pricing?.subtotal ?? 0) || 0;
  const restaurantIdRaw =
    orderDoc?.restaurantId?._id ?? orderDoc?.restaurantId ?? null;

  if (!restaurantIdRaw) {
    return {
      commissionAmount: 0,
      commissionType: 'percentage',
      commissionValue: 0,
      baseAmount,
    };
  }

  const rules = await getActiveRestaurantCommissionRules();
  const rule =
    rules.find((r) => String(r.restaurantId) === String(restaurantIdRaw)) ||
    // Fallback: accept legacy docs where restaurantId may be stored under `restaurant` / `restaurant_id`
    rules.find((r) => String(r.restaurant || r.restaurant_id || '') === String(restaurantIdRaw)) ||
    null;

  if (!rule) {
    return {
      commissionAmount: 0,
      commissionType: 'percentage',
      commissionValue: 0,
      baseAmount,
    };
  }

  return computeRestaurantCommissionAmount(baseAmount, rule);
}

/**
 * Creates an initial 'pending' transaction when an order is created.
 */
export async function createInitialTransaction(order) {
    if (!order) return null;

    const { commissionAmount = 0 } = await getRestaurantCommissionSnapshot(order).catch(() => ({ commissionAmount: 0 }));
    
    // Split logic - Ensure all values are finite numbers
    const totalCustomerPaid = Number(order.pricing?.total) || 0;
    const riderShare = Number(order.riderTotalPayout) || Number(order.riderEarning) || 0;
    
    // Prefer commission already computed & stored on the order (source of truth for this order),
    // fallback to rule snapshot for older orders.
    const restaurantCommissionFromOrder = Number(order.pricing?.restaurantCommission);
    const restaurantCommission =
        Number.isFinite(restaurantCommissionFromOrder) && restaurantCommissionFromOrder > 0
            ? restaurantCommissionFromOrder
            : (Number(commissionAmount) || 0);

    const discount = Number(order.pricing?.discount) || 0;
    const subtotal = Number(order.pricing?.subtotal) || 0;
    const packagingFee = Number(order.pricing?.packagingFee) || 0;
    const platformFee = Number(order.pricing?.platformFee) || 0;
    const deliveryFee = Number(order.pricing?.deliveryFee) || 0;
    const adminDeliveryCommissionEnabled = order.pricing?.adminDeliveryCommissionEnabled === true;
    const adminDeliveryCommissionPercent = Number(order.pricing?.adminDeliveryCommissionPercent) || 0;
    const adminDeliveryCommissionAmount = Number(order.pricing?.adminDeliveryCommissionAmount) || 0;
    const riderDeliveryEarningAfterAdminCommission = Number(order.pricing?.riderDeliveryEarningAfterAdminCommission) || deliveryFee;
    const deliveryPartnerIncentiveEnabled = order.pricing?.deliveryPartnerIncentiveEnabled === true;
    const deliveryPartnerIncentivePercent = Number(order.pricing?.deliveryPartnerIncentivePercent) || 0;
    const deliveryPartnerIncentiveAmount = Number(order.pricing?.deliveryPartnerIncentiveAmount) || 0;
    const deliveryPartnerIncentiveEligible = order.pricing?.deliveryPartnerIncentiveEligible === true;
    const surgeAmount = Number(order.pricing?.surgeAmount) || 0;
    const tax = Number(order.pricing?.tax) || 0;
    const riderBasePay = Number(order.riderBasePay) || Number(order.pricing?.deliveryFeeBreakdown?.basePayout) || 0;
    const riderDeliveryFeeShare = Number(order.riderDeliveryFeeShare) || riderDeliveryEarningAfterAdminCommission;
    const riderSurgePay = Number(order.riderSurgePay) || surgeAmount;
    const riderIncentivePay = Number(order.riderIncentivePay) || deliveryPartnerIncentiveAmount;
    const riderTotalPayout =
        Number(order.riderTotalPayout) ||
        Number(order.riderEarning) ||
        Math.round((riderBasePay + riderDeliveryFeeShare + riderSurgePay + riderIncentivePay) * 100) / 100;

    let restaurantNet = subtotal + packagingFee - restaurantCommission;
    let platformNetProfit = platformFee + deliveryFee + surgeAmount + restaurantCommission - riderShare;

    // Handle discount attribution
    const couponCode = order.pricing?.couponCode;
    if (discount > 0 && couponCode) {
        try {
            // Dynamic import to avoid circular dependency if any
            const { FoodOffer } = await import('../../admin/models/offer.model.js');
            const offer = await FoodOffer.findOne({ couponCode: String(couponCode).toUpperCase() }).lean();
            if (offer?.createdByRole === 'RESTAURANT') {
                restaurantNet -= discount;
            } else {
                // Admin created (default) or not found
                platformNetProfit -= discount;
            }
        } catch (err) {
            // Log but don't fail, default to admin attribution
            platformNetProfit -= discount;
        }
    }

    // Ensure nets are finite and rounded
    restaurantNet = Math.round((Number(restaurantNet) || 0) * 100) / 100;
    platformNetProfit = Math.max(0, Math.round((Number(platformNetProfit) || 0) * 100) / 100);

    const transaction = new FoodTransaction({
        orderId: order._id,
        userId: order.userId,
        restaurantId: order.restaurantId,
        deliveryPartnerId: order.dispatch?.deliveryPartnerId,
        paymentMethod: order.payment?.method || 'cash',
        status: order.payment?.status === 'paid' ? 'captured' : 'pending',
        payment: {
            method: String(order.payment?.method || 'cash'),
            status: String(order.payment?.status || 'cod_pending'),
            amountDue: Number(order.payment?.amountDue ?? totalCustomerPaid) || 0,
            razorpay: {
                orderId: String(order.payment?.razorpay?.orderId || ''),
                paymentId: String(order.payment?.razorpay?.paymentId || ''),
                signature: String(order.payment?.razorpay?.signature || ''),
            },
            qr: {
                qrId: String(order.payment?.qr?.qrId || ''),
                imageUrl: String(order.payment?.qr?.imageUrl || ''),
                paymentLinkId: String(order.payment?.qr?.paymentLinkId || ''),
                shortUrl: String(order.payment?.qr?.shortUrl || ''),
                status: String(order.payment?.qr?.status || ''),
                expiresAt: order.payment?.qr?.expiresAt || null,
            }
        },
        pricing: {
            subtotal: subtotal,
            tax: tax,
            packagingFee: packagingFee,
            deliveryFee: deliveryFee,
            deliveryFeeBreakdown: order.pricing?.deliveryFeeBreakdown || null,
            adminDeliveryCommissionEnabled,
            adminDeliveryCommissionPercent,
            adminDeliveryCommissionAmount,
            riderDeliveryEarningAfterAdminCommission,
            deliveryPartnerIncentiveEnabled,
            deliveryPartnerIncentivePercent,
            deliveryPartnerIncentiveAmount,
            deliveryPartnerIncentiveEligible,
            platformFee: platformFee,
            surgeAmount: surgeAmount,
            restaurantCommission: restaurantCommission,
            discount: discount,
            total: totalCustomerPaid,
            currency: String(order.pricing?.currency || order.currency || 'INR'),
        },
        amounts: {
            totalCustomerPaid: totalCustomerPaid,
            restaurantShare: Math.max(0, restaurantNet),
            restaurantCommission: restaurantCommission,
            riderShare: riderTotalPayout,
            riderDeliveryFeeShare: riderDeliveryFeeShare,
            adminDeliveryCommissionAmount: adminDeliveryCommissionAmount,
            riderBasePay: riderBasePay,
            riderSurgePay: riderSurgePay,
            riderIncentivePay: riderIncentivePay,
            riderTotalPayout: riderTotalPayout,
            platformNetProfit: platformNetProfit,
            taxAmount: tax
        },
        gateway: {
            razorpayOrderId: order.payment?.razorpay?.orderId,
            qrUrl: order.payment?.qr?.imageUrl
        },
        history: [{
            kind: 'created',
            amount: totalCustomerPaid,
            note: 'Initial transaction created with order'
        }]
    });

    await transaction.save();

    // Link back to the order
    try {
        await mongoose.model('FoodOrder').updateOne(
            { _id: order._id },
            { $set: { transactionId: transaction._id } }
        );
    } catch (err) {
        // Log but don't fail transaction if the backlink fails
    }

    return transaction;
}

/**
 * Updates transaction status (captured, settled, etc) and appends to history.
 */
export async function updateTransactionStatus(orderId, kind, details = {}) {
    const query = { orderId };
    const transaction = await FoodTransaction.findOne(query);
    if (!transaction) return null;

    if (details.status) transaction.status = details.status;
    if (details.razorpayPaymentId) transaction.gateway.razorpayPaymentId = details.razorpayPaymentId;
    if (details.razorpaySignature) transaction.gateway.razorpaySignature = details.razorpaySignature;
    
    transaction.history.push({
        kind,
        amount: transaction.amounts.totalCustomerPaid,
        at: new Date(),
        note: details.note || `Transaction updated: ${kind}`,
        recordedBy: { role: details.recordedByRole || 'SYSTEM', id: details.recordedById }
    });

    await transaction.save();
    return transaction;
}

/**
 * Updates the rider in the transaction when an order is accepted.
 */
export async function updateTransactionRider(orderId, riderId) {
    const query = { orderId };
    return await FoodTransaction.findOneAndUpdate(
        query,
        { $set: { deliveryPartnerId: riderId } },
        { new: true }
    );
}

/**
 * Marks restaurant as settled in the finance record.
 */
export async function settleRestaurant(orderId, adminId) {
    return await updateTransactionStatus(orderId, 'settled', {
        status: 'captured', // Ensure it's marked as captured if it was pending cash
        note: 'Restaurant payout settled by admin',
        recordedByRole: 'ADMIN',
        recordedById: adminId
    });
}
