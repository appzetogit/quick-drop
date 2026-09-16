import mongoose from 'mongoose';
import { QCPrescriptionRequest } from '../models/prescriptionRequest.model.js';
import { QCMedicalSettings } from '../../admin/models/medicalSettings.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { normalizeDeliveryAddress } from '../../shared/geo.utils.js';
import { findZoneForPoint, readAddressPoint, ZONE_VERTICALS } from '../../shared/zoneServiceability.js';
import { attachOutletTimingsToRestaurants } from '../../restaurant/services/outletTimings.service.js';
import { getRestaurantAvailabilityStatus } from '../../restaurant/helpers/restaurantAvailability.helper.js';
import { MEDICAL_STORE_TYPE } from '../../shared/storeType.js';
import {
    assertClaimable,
    effectiveStatus,
    hasDeclined,
    normalizeExpiryMinutes,
    normalizeRadiusKm,
    pharmaciesInRange,
    REQUEST_STATUS,
    wasInvited,
} from '../../shared/medicalRequest.js';
import { createPrescriptionOrder } from './prescriptionOrder.service.js';

/**
 * The broadcast half of medical ordering: one prescription, every pharmacy in
 * range, first to accept fills it.
 *
 * The direct half lives in prescriptionOrder.service.js and is untouched by
 * this file. A customer who picked a pharmacy gets that pharmacy; nothing here
 * runs for them, and no request document is written -- see the note on
 * createPrescriptionOrder.
 *
 * When a pharmacy accepts, the order is created by calling that same direct
 * path with the accepting pharmacy's id. Not copied, called: the zone check,
 * the opening-hours check and the "a medical order must carry a prescription"
 * rule are then provably the same two ways in, and a change to any of them
 * cannot apply to one and not the other.
 */

const toObjectId = (value, label) => {
    const raw = String(value || '');
    if (!mongoose.Types.ObjectId.isValid(raw)) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(raw);
};

/**
 * The platform's medical rules, with the defaults when an admin has never
 * opened the screen.
 *
 * Read, never written, by the request path: creating a settings document as a
 * side effect of a customer placing a request would make the first customer of
 * the day the author of the platform's configuration.
 */
export async function loadMedicalSettings() {
    const doc = await QCMedicalSettings.findOne().sort({ updatedAt: -1 }).lean();
    return {
        requestRadiusKm: normalizeRadiusKm(doc?.requestRadiusKm),
        requestExpiryMinutes: normalizeExpiryMinutes(doc?.requestExpiryMinutes),
        broadcastEnabled: doc?.broadcastEnabled !== false,
    };
}

/** Candidate pharmacies with their timings attached, so opening hours can be read. */
const loadPharmaciesWithTimings = async (zoneId) => {
    const sellers = await FoodRestaurant.find({
        storeType: MEDICAL_STORE_TYPE,
        status: 'approved',
    }).lean();

    /*
     * A pharmacy pinned to another zone does not deliver here. Matching the
     * direct path, which refuses the order outright in that case; a seller with
     * no zone of its own is left in, because that is how single-zone platforms
     * are set up and excluding them would empty the list.
     */
    const inZone = sellers.filter((seller) => {
        const sellerZone = seller?.zoneId ? String(seller.zoneId) : '';
        return !sellerZone || !zoneId || sellerZone === String(zoneId);
    });

    return attachOutletTimingsToRestaurants(inZone, { useDefaults: false });
};

const isOpenNow = (at) => (seller) => {
    try {
        return getRestaurantAvailabilityStatus(seller, at)?.isOpen === true;
    } catch {
        return false;
    }
};

/**
 * Pharmacies a customer at this point can order from, nearest first.
 *
 * The same selection a broadcast uses, so the list a customer browses and the
 * shops a broadcast reaches cannot disagree. Used by the customer's Medical
 * section for both of its buttons.
 */
export async function listNearbyPharmacies(userId, { lat, lng } = {}) {
    const point = { lat: Number(lat), lng: Number(lng) };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
        throw new ValidationError('Your location is needed to find pharmacies near you');
    }

    const settings = await loadMedicalSettings();
    const zone = await findZoneForPoint(point.lat, point.lng, ZONE_VERTICALS.MEDICAL);
    const sellers = await loadPharmaciesWithTimings(zone?._id);
    const now = new Date();
    const inRange = pharmaciesInRange(sellers, point, settings.requestRadiusKm, {
        isOpen: isOpenNow(now),
    });

    const byId = new Map(sellers.map((s) => [String(s._id), s]));
    return {
        radiusKm: settings.requestRadiusKm,
        broadcastEnabled: settings.broadcastEnabled,
        servesThisAddress: Boolean(zone),
        pharmacies: inRange.map((row) => {
            const seller = byId.get(String(row.pharmacyId)) || {};
            return {
                id: String(row.pharmacyId),
                name: row.name,
                distanceKm: row.distanceKm,
                profileImage: seller.profileImage || seller.image || '',
                area: seller.area || seller.location?.area || '',
                city: seller.city || seller.location?.city || '',
                rating: Number(seller.rating) || 0,
                totalRatings: Number(seller.totalRatings) || 0,
                isAcceptingOrders: seller.isAcceptingOrders !== false,
                estimatedDeliveryTimeMinutes: seller.estimatedDeliveryTimeMinutes ?? null,
                /*
                 * Enough for the customer to decide, without a second call.
                 *
                 * `isOpenNow` is the platform's own verdict rather than
                 * something the app works out from the two times below: it
                 * accounts for the day, the outlet's override and the shop's
                 * switch, and a screen that computed it from opening/closing
                 * alone would eventually disagree with the server that refuses
                 * the order. The times are for showing, not for deciding.
                 */
                openingTime: seller.openingTime || '',
                closingTime: seller.closingTime || '',
                openDays: Array.isArray(seller.openDays) ? seller.openDays : [],
                isOpenNow: isOpenNow(now)(seller),
                address: seller.location?.formattedAddress
                    || seller.location?.address
                    || [seller.location?.area, seller.location?.city].filter(Boolean).join(', '),
            };
        }),
    };
}

const emitToUser = (userId, event, payload) => {
    try {
        const io = getIO();
        if (!io) return;
        io.to(rooms.user(String(userId))).emit(event, payload);
    } catch (err) {
        logger.warn(`prescription request emit to user failed: ${err?.message || err}`);
    }
};

const emitToPharmacies = (pharmacyIds, event, payload) => {
    try {
        const io = getIO();
        if (!io) return;
        for (const id of pharmacyIds) {
            io.to(rooms.restaurant(String(id))).emit(event, payload);
        }
    } catch (err) {
        logger.warn(`prescription request emit to pharmacies failed: ${err?.message || err}`);
    }
};

const publicRequest = (doc, now = new Date()) => ({
    id: String(doc._id),
    status: effectiveStatus(doc, now),
    prescriptionImageUrl: doc.prescriptionImageUrl,
    note: doc.note || '',
    radiusKm: doc.radiusKm,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
    invitedCount: (doc.invited || []).length,
    claimedBy: doc.claimedBy ? String(doc.claimedBy) : '',
    orderId: doc.orderId ? String(doc.orderId) : '',
});

/**
 * Broadcast a prescription to every pharmacy in range.
 *
 * Refuses rather than saving when nothing is in range. A request nobody was
 * sent is a request nobody will ever answer, and the customer would sit
 * watching it expire; told now, they can pick a pharmacy themselves or try a
 * different address.
 */
export async function createPrescriptionRequest(userId, dto = {}) {
    const settings = await loadMedicalSettings();
    if (!settings.broadcastEnabled) {
        throw new ValidationError('Sending to nearby pharmacies is turned off. Please choose a pharmacy.');
    }

    const imageUrl = String(dto.prescriptionImage || dto.prescriptionImageUrl || '').trim();
    if (!imageUrl) {
        throw new ValidationError('Upload a prescription to continue.');
    }

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

    const zone = await findZoneForPoint(point.lat, point.lng, ZONE_VERTICALS.MEDICAL);
    if (!zone) throw new ValidationError("We don't deliver to this address yet");

    const now = new Date();
    const sellers = await loadPharmaciesWithTimings(zone._id);
    const invited = pharmaciesInRange(sellers, point, settings.requestRadiusKm, {
        isOpen: isOpenNow(now),
    });

    if (!invited.length) {
        throw new ValidationError(
            `No pharmacy is open within ${settings.requestRadiusKm} km of this address right now.`,
        );
    }

    const request = await QCPrescriptionRequest.create({
        userId: toObjectId(userId, 'User ID'),
        zoneId: zone._id,
        prescriptionImageUrl: imageUrl,
        note: String(dto.note || '').slice(0, 500),
        deliveryAddress,
        location: { lat: point.lat, lng: point.lng },
        customerName: String(dto.customerName || deliveryAddress.fullName || ''),
        customerPhone: String(dto.customerPhone || deliveryAddress.phone || ''),
        radiusKm: settings.requestRadiusKm,
        expiresAt: new Date(now.getTime() + settings.requestExpiryMinutes * 60 * 1000),
        status: REQUEST_STATUS.OPEN,
        invited: invited.map((row) => ({ ...row, notifiedAt: now })),
    });

    emitToPharmacies(invited.map((row) => row.pharmacyId), 'medical:request_opened', {
        requestId: String(request._id),
        expiresAt: request.expiresAt,
    });

    return { request: publicRequest(request.toObject(), now), invitedCount: invited.length };
}

/** The customer's own requests, newest first. */
export async function listRequestsForUser(userId, { limit = 20 } = {}) {
    const rows = await QCPrescriptionRequest.find({ userId: toObjectId(userId, 'User ID') })
        .sort({ createdAt: -1 })
        .limit(Math.min(Math.max(Number(limit) || 20, 1), 100))
        .lean();
    const now = new Date();
    return rows.map((row) => publicRequest(row, now));
}

/**
 * The pharmacy's queue: prescriptions sent to it that are still going.
 *
 * Declined ones are gone from this list but not from the record -- the request
 * still carries who was offered it.
 */
export async function listRequestsForPharmacy(restaurantId, { limit = 50 } = {}) {
    const pharmacyId = toObjectId(restaurantId, 'Restaurant ID');
    const now = new Date();
    const rows = await QCPrescriptionRequest.find({
        'invited.pharmacyId': pharmacyId,
        status: REQUEST_STATUS.OPEN,
        expiresAt: { $gt: now },
        declinedBy: { $ne: pharmacyId },
    })
        .sort({ createdAt: -1 })
        .limit(Math.min(Math.max(Number(limit) || 50, 1), 100))
        .lean();

    return rows.map((row) => {
        const mine = (row.invited || []).find((i) => String(i.pharmacyId) === String(pharmacyId));
        return {
            ...publicRequest(row, now),
            distanceKm: mine?.distanceKm ?? null,
            customerName: row.customerName || '',
            area: row.deliveryAddress?.area || row.deliveryAddress?.city || '',
            /*
             * Not the full address. The pharmacy has not taken this order and
             * may never take it; where a customer lives is not something every
             * shop in the neighbourhood needs to know in order to decide
             * whether it stocks what the prescription asks for. The address
             * arrives with the order, once they accept it.
             */
        };
    });
}

/**
 * A pharmacy takes the request, and the order comes into existence.
 *
 * The claim is one conditional update, so two pharmacies pressing accept at the
 * same moment cannot both win: the second matches nothing and is told the first
 * got there. Order creation comes after the claim for the same reason -- two
 * orders for one prescription would be two shops dispensing the same medicine.
 *
 * If creating the order then fails, the claim is released rather than left
 * standing, because a request marked claimed with no order behind it is
 * invisible to everybody: the customer sees nothing coming and no other
 * pharmacy can pick it up.
 */
export async function claimPrescriptionRequest(requestId, restaurantId) {
    const id = toObjectId(requestId, 'Request ID');
    const pharmacyId = toObjectId(restaurantId, 'Restaurant ID');
    const now = new Date();

    // Read first, only to tell the pharmacist *why* they cannot have it.
    const existing = await QCPrescriptionRequest.findById(id).lean();
    if (!existing) throw new NotFoundError('That request no longer exists');
    assertClaimable(existing, pharmacyId, now);
    if (hasDeclined(existing, pharmacyId)) {
        throw new ValidationError('You passed on this request');
    }

    const claimed = await QCPrescriptionRequest.findOneAndUpdate(
        {
            _id: id,
            status: REQUEST_STATUS.OPEN,
            expiresAt: { $gt: now },
            'invited.pharmacyId': pharmacyId,
            declinedBy: { $ne: pharmacyId },
        },
        { $set: { status: REQUEST_STATUS.CLAIMED, claimedBy: pharmacyId, claimedAt: now } },
        { new: true },
    );

    if (!claimed) {
        // Somebody else won between the read above and this update.
        throw new ValidationError('Another pharmacy has already accepted this prescription');
    }

    let order;
    try {
        order = await createPrescriptionOrder(String(claimed.userId), {
            restaurantId: String(pharmacyId),
            prescriptionImage: claimed.prescriptionImageUrl,
            address: claimed.deliveryAddress,
            note: claimed.note,
            customerName: claimed.customerName,
            customerPhone: claimed.customerPhone,
        });
    } catch (err) {
        await QCPrescriptionRequest.updateOne(
            { _id: id, status: REQUEST_STATUS.CLAIMED, claimedBy: pharmacyId },
            { $set: { status: REQUEST_STATUS.OPEN, claimedBy: null, claimedAt: null } },
        );
        throw err;
    }

    const orderId = order?.orderMongoId || order?._id || order?.id;
    await QCPrescriptionRequest.updateOne({ _id: id }, { $set: { orderId } });

    emitToUser(claimed.userId, 'medical:request_claimed', {
        requestId: String(id),
        orderId: String(orderId || ''),
    });
    emitToPharmacies(
        (claimed.invited || []).map((row) => row.pharmacyId).filter((p) => String(p) !== String(pharmacyId)),
        'medical:request_closed',
        { requestId: String(id) },
    );

    return { request: publicRequest({ ...claimed.toObject(), orderId }, now), order };
}

/** The pharmacy passes; the request leaves its queue and stays open for the rest. */
export async function declinePrescriptionRequest(requestId, restaurantId) {
    const id = toObjectId(requestId, 'Request ID');
    const pharmacyId = toObjectId(restaurantId, 'Restaurant ID');
    const existing = await QCPrescriptionRequest.findById(id).lean();
    if (!existing) throw new NotFoundError('That request no longer exists');
    if (!wasInvited(existing, pharmacyId)) {
        throw new ValidationError('This request was not sent to your pharmacy');
    }
    await QCPrescriptionRequest.updateOne({ _id: id }, { $addToSet: { declinedBy: pharmacyId } });
    return { ok: true };
}

/** The customer changes their mind before anybody has taken it. */
export async function cancelPrescriptionRequest(requestId, userId) {
    const id = toObjectId(requestId, 'Request ID');
    const owner = toObjectId(userId, 'User ID');
    const now = new Date();
    const cancelled = await QCPrescriptionRequest.findOneAndUpdate(
        { _id: id, userId: owner, status: REQUEST_STATUS.OPEN },
        { $set: { status: REQUEST_STATUS.CANCELLED, cancelledAt: now } },
        { new: true },
    );
    if (!cancelled) {
        const existing = await QCPrescriptionRequest.findOne({ _id: id, userId: owner }).lean();
        if (!existing) throw new NotFoundError('That request no longer exists');
        if (effectiveStatus(existing, now) === REQUEST_STATUS.CLAIMED) {
            throw new ValidationError(
                'A pharmacy has already accepted this. Cancel the order instead.',
            );
        }
        return { request: publicRequest(existing, now) };
    }
    emitToPharmacies((cancelled.invited || []).map((row) => row.pharmacyId), 'medical:request_closed', {
        requestId: String(id),
    });
    return { request: publicRequest(cancelled.toObject(), now) };
}

/**
 * Admin: every request, for the Medical panel.
 *
 * Stale open rows are corrected to expired as they are read -- the panel would
 * otherwise show a queue of requests that look live and can no longer be
 * accepted by anyone.
 */
export async function listRequestsForAdmin({ status, limit = 50, page = 1 } = {}) {
    const now = new Date();
    await QCPrescriptionRequest.updateMany(
        { status: REQUEST_STATUS.OPEN, expiresAt: { $lte: now } },
        { $set: { status: REQUEST_STATUS.EXPIRED } },
    );

    const filter = {};
    const wanted = String(status || '').trim().toLowerCase();
    if (wanted && wanted !== 'all') {
        if (!Object.values(REQUEST_STATUS).includes(wanted)) {
            throw new ValidationError(`Unknown status: ${wanted.slice(0, 24)}`);
        }
        filter.status = wanted;
    }

    const perPage = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;
    const [rows, total] = await Promise.all([
        QCPrescriptionRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(perPage).lean(),
        QCPrescriptionRequest.countDocuments(filter),
    ]);

    return {
        total,
        page: Math.max(Number(page) || 1, 1),
        limit: perPage,
        requests: rows.map((row) => ({
            ...publicRequest(row, now),
            customerName: row.customerName || '',
            invited: (row.invited || []).map((i) => ({
                pharmacyId: String(i.pharmacyId),
                name: i.name || '',
                distanceKm: i.distanceKm ?? null,
            })),
        })),
    };
}

/** Admin: read and write the platform's medical rules. */
export async function getMedicalSettings() {
    return loadMedicalSettings();
}

export async function updateMedicalSettings(body = {}, adminId) {
    const current = await loadMedicalSettings();
    const next = {
        requestRadiusKm: body.requestRadiusKm === undefined
            ? current.requestRadiusKm
            : normalizeRadiusKm(body.requestRadiusKm),
        requestExpiryMinutes: body.requestExpiryMinutes === undefined
            ? current.requestExpiryMinutes
            : normalizeExpiryMinutes(body.requestExpiryMinutes),
        broadcastEnabled: body.broadcastEnabled === undefined
            ? current.broadcastEnabled
            : body.broadcastEnabled === true || body.broadcastEnabled === 'true',
        updatedBy: mongoose.Types.ObjectId.isValid(String(adminId || ''))
            ? new mongoose.Types.ObjectId(String(adminId))
            : null,
    };
    await QCMedicalSettings.findOneAndUpdate({}, { $set: next }, { upsert: true, new: true });
    return {
        requestRadiusKm: next.requestRadiusKm,
        requestExpiryMinutes: next.requestExpiryMinutes,
        broadcastEnabled: next.broadcastEnabled,
    };
}
