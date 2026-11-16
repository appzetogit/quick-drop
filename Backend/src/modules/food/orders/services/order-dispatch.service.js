import mongoose from 'mongoose';
import { FoodOrder, FoodSettings } from '../models/order.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { FoodDeliveryCashDeposit } from '../../delivery/models/foodDeliveryCashDeposit.model.js';
import { getDeliveryCashLimitSettings } from '../../admin/services/admin.service.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { logger } from '../../../../utils/logger.js';
import { config } from '../../../../config/env.js';
import { getIO, rooms } from '../../../../config/socket.js';
/*
 * Zone matching. A rider is only offered an order from their own zone.
 *
 * Every selection path below was zone-blind, and with a single rider online the
 * fallback at the end handed him every order on the platform -- an Indore rider
 * being offered Palampur orders 700km away.
 */
import { loadActiveZones, filterCandidatesToZone, resolveZoneIdForPoint } from '../../shared/zoneMatching.js';
import { compareInBackground } from '../../../../core/finance/eligibilityShadow.js';
import { addOrderJob } from '../../../../queues/producers/order.producer.js';
import {
  buildDeliverySocketPayload,
  buildOrderIdentityFilter,
  haversineKm,
  notifyOwnerSafely,
  notifyOwnersSafely,
} from './order.helpers.js';

/**
 * Driver unification: keep only partners whose linked unified Driver is free (no cross-service
 * busy-lock) and whose work mode accepts deliveries. Partners not yet migrated (no driverId)
 * are kept, so the legacy flow keeps working during the dual-run phase.
 * No-op — and no extra query — while UNIFIED_DISPATCH_ENABLED is off.
 */
async function filterByUnifiedWorkMode(partners) {
  if (!config.unifiedDispatchEnabled || !partners?.length) return partners || [];
  const ids = partners.map((p) => p._id);
  const rows = await FoodDeliveryPartner.find({ _id: { $in: ids } }).select('_id driverId').lean();
  const driverIdByPartner = new Map(rows.filter((r) => r.driverId).map((r) => [String(r._id), r.driverId]));
  if (driverIdByPartner.size === 0) return partners;

  const { Driver } = await import('../../../taxi/driver/models/Driver.js');
  const freeDrivers = await Driver.find({
    _id: { $in: [...driverIdByPartner.values()] },
    activeAssignment: null,
    workMode: { $in: ['all', 'delivery'] },
    serviceCapabilities: 'delivery',
  }).select('_id').lean();
  const freeIds = new Set(freeDrivers.map((d) => String(d._id)));

  return partners.filter((p) => {
    const linked = driverIdByPartner.get(String(p._id));
    if (!linked) return true;           // not migrated yet — don't block
    return freeIds.has(String(linked)); // migrated — must be free + accepting deliveries
  });
}

async function listNearbyOnlineDeliveryPartners(
  restaurantId,
  { maxKm = 15, limit = 25 } = {},
) {
  const rId = (restaurantId?._id || restaurantId).toString();
  const restaurant = await FoodRestaurant.findById(rId)
    .select("location zoneId")
    .lean();

  // Resolved once and applied to every path below, including the fallbacks.
  const zones = await loadActiveZones();
  const [rLngRaw, rLatRaw] = restaurant?.location?.coordinates || [];
  // A restaurant saved without a zone is placed by its own location, so the
  // zone rule still holds (it was skipped entirely before).
  const orderZoneId = restaurant?.zoneId
    ? String(restaurant.zoneId)
    : resolveZoneIdForPoint(rLatRaw, rLngRaw, zones);
  const zoneScope = (rows) => filterCandidatesToZone(rows, orderZoneId, zones);

  if (!restaurant?.location?.coordinates?.length) {
    // Neither a location nor a zone: nothing to match riders against, so no one
    // is offered it (the same as quick commerce) rather than everyone online.
    if (!orderZoneId) return { restaurant: null, partners: [] };
    const partners = await FoodDeliveryPartner.find({
      status: "approved",
      availabilityStatus: "online",
    })
      .select("_id status name lastLat lastLng")
      .lean();

    // The restaurant has no coordinates, so distance cannot be judged -- but the
    // zone still can, from each rider's own position.
    const { kept } = zoneScope(
      partners.map((p) => ({ partnerId: p._id, lat: p.lastLat, lng: p.lastLng })),
    );

    return {
      restaurant: null,
      partners: kept
        .slice(0, Math.max(1, limit))
        .map((p) => ({ partnerId: p.partnerId, distanceKm: null })),
    };
  }

  const [rLng, rLat] = restaurant.location.coordinates;
  const allOnline = await FoodDeliveryPartner.find({
    availabilityStatus: "online",
  })
    .select("_id status lastLat lastLng lastLocationAt name")
    .lean();

  // Driver unification: drop partners whose unified driver is busy on another job or whose
  // work-mode excludes deliveries. Flag-gated; no-op (and no extra query) while disabled.
  const unified = await filterByUnifiedWorkMode(allOnline);
  // Riders already carrying an order (Food or Quick/Medical) are judged by the
  // caller against the order itself: core/delivery/batching.js.
  const eligible = unified;

  const scored = [];
  const allowedStatuses = process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];
  // Same window as quick commerce (DISPATCH_STALE_GPS_MS, 45 min): a phone in
  // Doze stops uploading, and last-known coordinates that old are still usable.
  const STALE_GPS_MS = Number(process.env.DISPATCH_STALE_GPS_MS) || 45 * 60 * 1000;
  const isFresh = (p) => p.lastLat != null && p.lastLng != null && p.lastLocationAt
    && Date.now() - new Date(p.lastLocationAt).getTime() <= STALE_GPS_MS;

  for (const p of eligible) {
    if (!allowedStatuses.includes(p.status)) continue;

    /*
     * Position unknown or too old: the rider cannot be placed, so they are not
     * offered the order. This used to score them as 999km and keep them when
     * the restaurant had no zone -- which is how a rider in Indore was offered
     * a Palampur order.
     */
    if (!isFresh(p)) continue;

    const d = haversineKm(rLat, rLng, p.lastLat, p.lastLng);
    if (Number.isFinite(d) && d <= maxKm) {
      scored.push({ partnerId: p._id, distanceKm: d, status: p.status, lat: p.lastLat, lng: p.lastLng });
    }
  }

  // Distance is not the same question as zone: two zones can sit inside 15km of
  // each other, and an order must still stay in its own.
  const zoneScoped = zoneScope(scored);
  // Copied first: with no zone enforced, `kept` IS `scored`, and clearing
  // `scored` emptied it too -- every dispatch then fell through to the 60 km
  // fallback and skipped the 15/25/40 km steps.
  const keptInZone = zoneScoped.kept.slice();
  scored.length = 0;
  scored.push(...keptInZone);

  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  const picked = scored.slice(0, Math.max(1, limit));

  if (picked.length === 0) {
    /*
     * Nobody within range. The net widens past `maxKm` -- but never past the
     * zone.
     *
     * This is the path that produced the report. It returned every online rider
     * on the platform with no distance and no zone test, so with a single rider
     * online he received every order from every city. Widening the radius is a
     * reasonable last resort; ignoring the zone is not, and a rider 700km away
     * cannot deliver the order however few candidates there are.
     */
    const FALLBACK_MAX_KM = Math.max(60, Number(maxKm) || 0);
    const anyOnline = await FoodDeliveryPartner.find({
      status: { $in: allowedStatuses },
      availabilityStatus: "online",
    })
      .select("_id status name lastLat lastLng lastLocationAt")
      .lean();

    // Only riders placed recently and within reach of the restaurant; then the zone.
    const reachable = anyOnline
      .filter((p) => isFresh(p))
      .map((p) => ({
        partnerId: p._id,
        status: p.status,
        lat: p.lastLat,
        lng: p.lastLng,
        distanceKm: haversineKm(rLat, rLng, p.lastLat, p.lastLng),
      }))
      .filter((p) => Number.isFinite(p.distanceKm) && p.distanceKm <= FALLBACK_MAX_KM);

    const { kept, enforced, dropped } = zoneScope(reachable);

    if (enforced && dropped.length) {
      logger.info(
        `[dispatch] restaurant ${rId}: ${dropped.length} online rider(s) skipped, outside zone ${orderZoneId}`,
      );
    }

    kept.sort((a, b) => a.distanceKm - b.distanceKm);
    return {
      partners: kept.slice(0, Math.max(1, limit)).map((p) => ({
        partnerId: p.partnerId,
        distanceKm: p.distanceKm,
        status: p.status,
      })),
    };
  }

  const final = (config.env === 'production')
    ? picked.filter(p => p.status === 'approved')
    : picked;

  return { partners: final };
}

async function filterPartnersByCodCashLimit(partners = [], order = null) {
  if (!Array.isArray(partners) || partners.length === 0) return [];

  const paymentMethod = String(order?.payment?.method || '').trim().toLowerCase();
  if (paymentMethod !== 'cash') {
    return partners;
  }

  const orderCashImpact = Math.max(0, Number(order?.pricing?.total) || 0);

  /*
   * The rider's cash, as the rider app and the withdrawal check see it:
   * riderFinance sums food, quick commerce and taxi, and resolves the limit the
   * admin set for this rider or zone. This counted only DELIVERED FOOD orders
   * against the old global setting, so cash from picked-up orders, grocery
   * runs and taxi fares was invisible and per-rider limits never applied.
   * A limit of 0 means "no limit", as everywhere else in riderFinance.
   */
  const { getRiderFinance } = await import('../../../../core/finance/riderFinance.service.js');
  const verdicts = await Promise.all(partners.map(async (partner) => {
    try {
      const f = await getRiderFinance(partner?.partnerId);
      // Not f.isBlocked: that is the TAXI wallet rule (a food-only rider with
      // no taxi balance reads as blocked). Only the cash ceiling applies here.
      const limit = Number(f?.cashLimit) || 0;
      if (limit <= 0) return true;
      return (Number(f?.cashInHand) || 0) + orderCashImpact <= limit;
    } catch (err) {
      logger.warn(`COD cash-limit check failed for partner ${partner?.partnerId}: ${err?.message || err}`);
      return false;
    }
  }));
  const eligiblePartners = partners.filter((_, i) => verdicts[i]);

  const skippedCount = partners.length - eligiblePartners.length;
  if (skippedCount > 0) {
    logger.info(
      `COD cash-limit filter skipped ${skippedCount} delivery partner(s) for order ${order?._id || ''}.`,
    );
  }

  /*
   * Measure the master eligibility engine against this gate. Decides nothing.
   *
   * The figure above is food's own: cash collected on FOOD orders minus deposits,
   * so a rider holding Rs 1,500 from grocery runs and taxi fares reads as having
   * collected nothing and is dispatched. The engine asks riderFinance, which knows
   * about all three. This logs where the two answers part company so the cutover
   * is made from evidence -- and so the boundary difference is visible too: this
   * filter allows `projected == limit`, the engine refuses it.
   *
   * No-op, and no extra query, unless ELIGIBILITY_SHADOW_ENABLED is set.
   */
  compareInBackground({
    vertical: 'food',
    candidates: partners,
    legacyEligible: eligiblePartners,
    jobId: order?._id,
    jobCashExposure: orderCashImpact,
  });

  return eligiblePartners;
}

/*
 * Security-deposit gate. Applies to EVERY order (cash and online), unlike the
 * COD cash filter above: a rider who has not paid the admin-set refundable
 * security deposit is not offered work at all.
 *
 * Inert by default: when the admin-set requirement is 0 the setting read is the
 * only cost and all partners pass. Fail-open on a settings error -- a transient
 * read failure must not halt dispatch platform-wide.
 */
async function filterPartnersBySecurityDeposit(partners = [], order = null) {
  if (!Array.isArray(partners) || partners.length === 0) return partners;

  let required = 0;
  try {
    const { getDeliveryCashLimitSettings } = await import('../../admin/services/admin.service.js');
    required = Math.max(0, Number((await getDeliveryCashLimitSettings())?.deliverySecurityDeposit) || 0);
  } catch (err) {
    logger.warn(`security-deposit setting unavailable, not gating: ${err?.message || err}`);
    return partners;
  }
  if (required <= 0) return partners;

  const { getRiderFinance } = await import('../../../../core/finance/riderFinance.service.js');
  const verdicts = await Promise.all(partners.map(async (partner) => {
    try {
      const f = await getRiderFinance(partner?.partnerId);
      return f?.securityMet === true;
    } catch (err) {
      logger.warn(`security-deposit check failed for partner ${partner?.partnerId}: ${err?.message || err}`);
      return false;
    }
  }));
  const eligible = partners.filter((_, i) => verdicts[i]);
  const skipped = partners.length - eligible.length;
  if (skipped > 0) {
    logger.info(`security-deposit filter skipped ${skipped} delivery partner(s) for order ${order?._id || ''}.`);
  }
  return eligible;
}

export async function getDispatchSettings() {
  return { dispatchMode: "auto" };
}

export async function updateDispatchSettings(dispatchMode, adminId) {
  // Always set to auto
  await FoodSettings.findOneAndUpdate(
    { key: "dispatch" },
    {
      $set: {
        dispatchMode: "auto",
        updatedBy: { role: "ADMIN", adminId, at: new Date() },
      },
    },
    { upsert: true, new: true },
  );
  return getDispatchSettings();
}

/**
 * The restaurant document an offer needs, not its id.
 *
 * buildDeliverySocketPayload reads restaurantName, location and phone off
 * this. Handing it the ObjectId — which is what the call did — produced a
 * payload with an empty name, an empty pickup address and no coordinates,
 * so the rider was shown "Restaurant / Pickup Location" and asked to
 * accept. Returns null on failure, which is the old behaviour.
 */
/**
 * What the full-screen alert needs, in the push itself.
 *
 * A backgrounded rider has no socket, and the alert is built straight
 * from this map — so anything missing here is a placeholder on their
 * screen. Every value is a string because FCM data may not hold anything
 * else.
 */
const offerPushData = (order, payload = {}) => {
  const str = (value) => (value === null || value === undefined ? '' : String(value));
  return {
    type: 'new_order',
    // One explicit label the native incoming-order card's heading switches
    // on, alongside the medical/quick-commerce forks of this same payload
    // builder -- see their own jobType for why this replaces guessing from
    // order-code prefixes.
    jobType: 'food',
    orderId: order._id.toString(),
    restaurantName: str(payload.restaurantName),
    restaurantAddress: str(payload.restaurantAddress),
    pickupAddress: str(payload.restaurantAddress),
    customerName: str(payload.customerName),
    customerAddress: str(payload.customerAddress),
    dropAddress: str(payload.customerAddress),
    tripDistanceKm: str(payload.tripDistanceKm),
    tripDurationMins: str(payload.tripDurationMins),
    earningAmount: str(payload.earningAmount ?? payload.riderEarning),
    total: str(payload.total),
    // The rider app falls back to "cash" when these are missing, so a
    // prepaid order offered by push read as cash on delivery.
    paymentMethod: str(payload.paymentMethod || order?.payment?.method),
    paymentStatus: str(payload.paymentStatus || order?.payment?.status),
  };
};

const offerRestaurantDoc = async (order) => {
  const id = order?.restaurantId?._id || order?.restaurantId;
  if (!id) return null;
  // Already populated by the caller: use it rather than fetching again.
  if (typeof order.restaurantId === 'object' && order.restaurantId?.restaurantName) {
    return order.restaurantId;
  }
  try {
    return await FoodRestaurant.findById(id)
      .select('restaurantName location addressLine1 area city state phone ownerPhone primaryContactNumber')
      .lean();
  } catch {
    return null;
  }
};

/** How long one rider has to accept an auto-dispatched order before the next is offered it. */
const SEQUENTIAL_OFFER_MS = Math.max(15, Math.min(120, Number(process.env.FOOD_OFFER_WINDOW_SECONDS) || 30)) * 1000;

export async function tryAutoAssign(orderId, options = {}) {
  const attempt = options.attempt || 1;
  const lockTimeout = 55000; // 55 seconds lock interval

  const order = await FoodOrder.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(orderId),
      $or: [
        { 'dispatch.status': 'unassigned' },
        {
          'dispatch.status': 'assigned',
          'dispatch.acceptedAt': { $exists: false },
          'dispatch.assignedAt': { $lt: new Date(Date.now() - lockTimeout) },
          // An admin's pick is not a stale offer: it is the assigned rider's for
          // the whole manual window (core/delivery/manualAssign.js), and the
          // expiry sweep -- which tells the rider -- hands it back afterwards.
          $or: [
            { 'dispatch.assignMode': { $ne: 'manual' } },
            { 'dispatch.manualDeadlineAt': { $not: { $gt: new Date() } } },
          ],
        }
      ],
      'dispatch.dispatchingAt': { $exists: false }
    },
    {
      $set: { 'dispatch.dispatchingAt': new Date() }
    },
    { new: true }
  ).populate(['restaurantId', 'userId']);

  if (!order) {
    logger.info(`tryAutoAssign: Skip for ${orderId} (already dispatching, accepted, or multi-attempt lock active).`);
    return null;
  }

  // Decoupling: Ensure order is accepted by restaurant before dispatching to delivery boys
  const DISPATCHABLE_STATUSES = ['confirmed', 'preparing', 'ready_for_pickup', 'ready', 'reached_pickup', 'picked_up', 'reached_drop'];
  if (!DISPATCHABLE_STATUSES.includes(order.orderStatus)) {
    logger.info(`tryAutoAssign: Skip for ${orderId} (status ${order.orderStatus} not dispatchable yet).`);
    // Release the claim taken above; left set, it blocked dispatch for up to
    // five minutes (until the stale-lock sweep) after the restaurant confirmed.
    await FoodOrder.updateOne({ _id: order._id }, { $unset: { 'dispatch.dispatchingAt': '' } });
    return order;
  }

  /*
   * A rider is still inside their window on this order. Offers go one rider at
   * a time, and a second dispatch chain (a resend, a sweep) must not offer it
   * to someone else meanwhile -- that is how riders ended up getting the same
   * order together. The timeout job that ends this window dispatches next.
   */
  const liveOffer = order.dispatch?.currentOffer;
  if (
    !options.force
    && liveOffer?.partnerId
    && liveOffer?.expiresAt
    && new Date(liveOffer.expiresAt).getTime() > Date.now()
    && order.dispatch?.status === 'unassigned'
  ) {
    logger.info(`tryAutoAssign: ${orderId} is with rider ${liveOffer.partnerId} until ${new Date(liveOffer.expiresAt).toISOString()} -- waiting.`);
    await FoodOrder.updateOne({ _id: order._id }, { $unset: { 'dispatch.dispatchingAt': '' } });
    return order;
  }

  try {
    const offeredIds = (order.dispatch?.offeredTo || []).map(o => o.partnerId.toString());
    
    // RADIUS EXPANSION LOGIC
    // Attempt 1: 15km, Attempt 2: 25km, Attempt 3: 40km, Attempt 4+: 60km
    let maxKm = 15;
    if (attempt === 2) maxKm = 25;
    if (attempt === 3) maxKm = 40;
    if (attempt >= 4) maxKm = 60;

    const searchOptions = { maxKm, limit: 15 };
    let { partners } = await listNearbyOnlineDeliveryPartners(order.restaurantId, searchOptions);
    // A rider on a trip is offered this order only if it can join that trip
    // (batching on, same or nearby store, nearby drop, nothing picked up yet).
    // This also ends the old gap where a rider on a Food trip was offered every
    // further Food order.
    {
      const { foodRidersBlockedFor } = await import('../../../../core/delivery/batching.js');
      const blocked = await foodRidersBlockedFor((partners || []).map((p) => p.partnerId), order, 'food')
        .catch(() => new Set());
      partners = (partners || []).filter((p) => !blocked.has(String(p.partnerId)));
    }
    
    // Admin alert: offers now go one rider at a time, one round per offer
    // window, so every 10th round is roughly every five minutes unassigned.
    const isPhase3 = attempt >= 10 && attempt % 10 === 0;

    if (isPhase3) {
      logger.error(`[CRITICAL] Order ${order._id} unassigned for ${attempt} mins. Triggering Admin Alert (Phase 3).`);
      // Notify Admin via Push (Web/Mobile)
      try {
        await notifyOwnersSafely(
          [{ ownerType: 'ADMIN', ownerId: 'GLOBAL' }], // Use GLOBAL or specific admin group if defined
          {
            title: 'Unassigned Order Crisis!',
            body: `Order #${order.order_id || order._id} has not been picked up for 5+ minutes. Manual intervention required!`,
            data: { type: 'admin_alert_unassigned', orderId: order._id.toString() }
          }
        );
      } catch (err) {
        logger.warn(`Admin notification failed: ${err.message}`);
      }
    }

    const securedPartners = await filterPartnersBySecurityDeposit(partners, order);
    const codEligiblePartners = await filterPartnersByCodCashLimit(securedPartners, order);
    /*
     * ONE RIDER AT A TIME.
     *
     * This used to broadcast every round to up to 15 riders at once, and when it
     * ran out of new ones it re-sent to all of them again -- so every nearby
     * rider's phone rang for the same order together and they raced for it.
     *
     * Now each round offers the order to a single rider for SEQUENTIAL_OFFER_MS:
     * whoever has been offered it the fewest times, best-placed first among
     * equals (listNearbyOnlineDeliveryPartners already returns them nearest /
     * best first). The rider whose window just ran out is skipped while anyone
     * else is available, so once everyone has had a turn the order cycles round
     * again instead of being blasted to all. Only the current rider can accept
     * (order-delivery.service.js acceptOrderDelivery); the previous one's alert
     * is dismissed.
     */
    const offerCounts = new Map();
    for (const o of order.dispatch?.offeredTo || []) {
      const key = String(o.partnerId);
      offerCounts.set(key, (offerCounts.get(key) || 0) + 1);
    }
    const previousRider = order.dispatch?.currentOffer?.partnerId
      ? String(order.dispatch.currentOffer.partnerId)
      : null;
    let pool = codEligiblePartners;
    if (pool.length > 1 && previousRider) {
      pool = pool.filter((p) => String(p.partnerId) !== previousRider);
    }
    // Array.prototype.sort is stable, so equal counts keep the nearest-first order.
    const next = pool
      .slice()
      .sort((a, b) => (offerCounts.get(String(a.partnerId)) || 0) - (offerCounts.get(String(b.partnerId)) || 0))[0];

    const io = getIO();
    // The previous rider's window is over: take the alert off their screen.
    if (io && previousRider && (!next || String(next.partnerId) !== previousRider)) {
      io.to(rooms.delivery(previousRider)).emit('order_claimed', {
        orderId: order._id.toString(),
        orderMongoId: order._id.toString(),
        claimedBy: '',
        reason: 'offer_expired',
      });
    }

    if (!next) {
      logger.info(`tryAutoAssign: No eligible partners in ${maxKm}km for order ${order._id}. Retrying in 30s.`);
      await FoodOrder.updateOne(
        { _id: order._id, 'dispatch.status': 'unassigned' },
        { $unset: { 'dispatch.currentOffer': '' } },
      );
      await addOrderJob({
        action: 'DISPATCH_TIMEOUT_CHECK',
        orderMongoId: order._id.toString(),
        orderId: order._id.toString(),
        attempt: attempt + 1
      }, { delay: 30000 });
      return order;
    }

    const offeredAt = new Date();
    const expiresAt = new Date(offeredAt.getTime() + SEQUENTIAL_OFFER_MS);
    const windowSeconds = Math.round(SEQUENTIAL_OFFER_MS / 1000);

    /*
     * Record the offer before sending it, so the rider can accept the moment
     * the alert lands. Conditional update, not order.save() -- this document was
     * loaded before the rider lookup, and in that time a rider may have accepted
     * or an admin may have assigned one by hand (core/delivery/manualAssign.js).
     */
    const reoffer = await FoodOrder.updateOne(
      {
        _id: order._id,
        'dispatch.status': { $ne: 'accepted' },
        'dispatch.acceptedAt': { $exists: false },
        $nor: [{
          'dispatch.assignMode': 'manual',
          'dispatch.status': 'assigned',
          'dispatch.manualDeadlineAt': { $gt: new Date() },
        }],
      },
      {
        $set: {
          'dispatch.status': 'unassigned',
          'dispatch.deliveryPartnerId': null,
          'dispatch.assignMode': 'auto',
          'dispatch.currentOffer': { partnerId: next.partnerId, at: offeredAt, expiresAt },
        },
        $unset: { 'dispatch.manualDeadlineAt': '' },
        $push: { 'dispatch.offeredTo': { partnerId: next.partnerId, at: offeredAt, action: 'offered' } },
      },
    );
    if (reoffer.modifiedCount === 0) {
      logger.info(`tryAutoAssign: order ${order._id} was accepted or assigned meanwhile -- leaving it.`);
      return order;
    }

    const payload = {
      ...buildDeliverySocketPayload(order, await offerRestaurantDoc(order)),
      acceptanceDeadlineAt: expiresAt.toISOString(),
      acceptTimeoutSeconds: windowSeconds,
    };
    logger.info(`Offering order ${order._id} to rider ${next.partnerId} for ${windowSeconds}s (round ${attempt}, ${codEligiblePartners.length} eligible).`);
    if (io) io.to(rooms.delivery(next.partnerId)).emit('new_order', { ...payload, pickupDistanceKm: next.distanceKm });

    try {
      await notifyOwnersSafely(
        [{ ownerType: 'DELIVERY_PARTNER', ownerId: next.partnerId }],
        {
          title: 'New order available!',
          body: `Order #${order.order_id || order._id} is available. You have ${windowSeconds} seconds to accept!`,
          data: {
            ...offerPushData(order, payload),
            acceptanceDeadlineAt: expiresAt.toISOString(),
            acceptTimeoutSeconds: String(windowSeconds),
          },
        }
      );
    } catch (err) {
      logger.warn(`Push notification failed for offer on order ${order._id}: ${err.message}`);
    }

    // When this rider's window ends, offer the next one.
    await addOrderJob({
      action: 'DISPATCH_TIMEOUT_CHECK',
      orderMongoId: order._id.toString(),
      orderId: order._id.toString(),
      attempt: attempt + 1
    }, { delay: SEQUENTIAL_OFFER_MS + 1000 });

    return order;
  } finally {
    await FoodOrder.findByIdAndUpdate(orderId, {
      $unset: { 'dispatch.dispatchingAt': '' },
    });
  }
}


export async function processDispatchTimeout(orderId, partnerId) {
  const order = await FoodOrder.findById(orderId);
  if (!order) return;

  const stillAssigned = order.dispatch?.status === 'assigned' &&
    String(order.dispatch?.deliveryPartnerId) === String(partnerId) &&
    !order.dispatch?.acceptedAt;

  if (stillAssigned) {
    logger.info(`Dispatch timeout for partner ${partnerId} on order ${orderId}. Re-trying hunt...`);
    const offer = order.dispatch.offeredTo.find(
      o => String(o.partnerId) === String(partnerId) && o.action === 'offered'
    );
    if (offer) offer.action = 'timeout';

    order.dispatch.status = 'unassigned';
    order.dispatch.deliveryPartnerId = null;
    await order.save();
    
    const attempt = (order.dispatch?.offeredTo?.length || 0) + 1;
    await tryAutoAssign(orderId, { attempt });
  } else if (order.dispatch?.status === 'unassigned') {
    // If it's already unassigned (e.g. from a previous timeout), just keep hunting
    const attempt = (order.dispatch?.offeredTo?.length || 0) + 1;
    await tryAutoAssign(orderId, { attempt });
  }
}


export async function resendDeliveryNotificationRestaurant(orderId, restaurantId) {
  const identity = buildOrderIdentityFilter(orderId);
  const order = await FoodOrder.findOne({
    ...identity,
    restaurantId: new mongoose.Types.ObjectId(restaurantId),
  });

  if (!order) throw new NotFoundError('Order not found');

  const activeStatuses = ['confirmed', 'preparing', 'ready_for_pickup', 'ready'];
  if (!activeStatuses.includes(order.orderStatus)) {
    throw new ValidationError(`Cannot resend notification for order in status: ${order.orderStatus}`);
  }

  if (order.dispatch?.status === 'accepted') {
    throw new ValidationError('A delivery partner has already accepted this order.');
  }
  // An admin picked a rider and they are still inside their window to answer.
  if (order.dispatch?.assignMode === 'manual' && order.dispatch?.status === 'assigned'
    && order.dispatch?.manualDeadlineAt && new Date(order.dispatch.manualDeadlineAt) > new Date()) {
    throw new ValidationError('Our team has assigned a rider to this order and is waiting for them to accept.');
  }

  order.dispatch.status = 'unassigned';
  order.dispatch.deliveryPartnerId = null;
  order.dispatch.offeredTo = [];
  order.dispatch.currentOffer = undefined;
  order.dispatch.assignMode = 'auto';
  order.dispatch.manualDeadlineAt = undefined;
  await order.save();

  // A fresh round starts with the nearest rider; force past the live-offer wait.
  await tryAutoAssign(order._id, { force: true });
  return { success: true };
}

/** For tests only: which riders an order at this restaurant would be offered to. */
export const __testables = { listNearbyOnlineDeliveryPartners };
