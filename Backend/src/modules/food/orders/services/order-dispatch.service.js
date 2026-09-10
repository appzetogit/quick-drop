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
import { loadActiveZones, filterCandidatesToZone } from '../../shared/zoneMatching.js';
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
  const orderZoneId = restaurant?.zoneId ? String(restaurant.zoneId) : null;
  const zoneScope = (rows) => filterCandidatesToZone(rows, orderZoneId, zones);

  if (!restaurant?.location?.coordinates?.length) {
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
  const eligible = await filterByUnifiedWorkMode(allOnline);

  const scored = [];
  const allowedStatuses = process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];
  const STALE_GPS_MS = 10 * 60 * 1000;

  for (const p of eligible) {
    if (!allowedStatuses.includes(p.status)) continue;

    const isStale = !p.lastLocationAt || (Date.now() - new Date(p.lastLocationAt).getTime()) > STALE_GPS_MS;
    if (p.lastLat == null || p.lastLng == null || isStale) {
      /*
       * Position unknown, so the zone cannot be confirmed. Kept only where no
       * zone is being enforced -- under enforcement this rider is exactly the
       * one that must not be offered another city's order, since "we don't know
       * where they are" is not a reason to assume they are nearby.
       */
      if (!orderZoneId || zones.length === 0) {
        scored.push({ partnerId: p._id, distanceKm: 999, status: p.status, lat: null, lng: null });
      }
      continue;
    }

    const d = haversineKm(rLat, rLng, p.lastLat, p.lastLng);
    if (Number.isFinite(d) && d <= maxKm) {
      scored.push({ partnerId: p._id, distanceKm: d, status: p.status, lat: p.lastLat, lng: p.lastLng });
    }
  }

  // Distance is not the same question as zone: two zones can sit inside 15km of
  // each other, and an order must still stay in its own.
  const zoneScoped = zoneScope(scored);
  scored.length = 0;
  scored.push(...zoneScoped.kept);

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
    const anyOnline = await FoodDeliveryPartner.find({
      status: { $in: allowedStatuses },
      availabilityStatus: "online",
    })
      .select("_id status name lastLat lastLng")
      .lean();

    const { kept, enforced, dropped } = zoneScope(
      anyOnline.map((p) => ({
        partnerId: p._id,
        status: p.status,
        lat: p.lastLat,
        lng: p.lastLng,
      })),
    );

    if (enforced && dropped.length) {
      logger.info(
        `[dispatch] restaurant ${rId}: ${dropped.length} online rider(s) skipped, outside zone ${orderZoneId}`,
      );
    }

    return {
      partners: kept.slice(0, Math.max(1, limit)).map((p) => ({
        partnerId: p.partnerId,
        distanceKm: null,
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

  const cashLimitSettings = await getDeliveryCashLimitSettings();
  const totalCashLimit = Number(cashLimitSettings?.deliveryCashLimit) || 0;
  if (totalCashLimit <= 0) {
    return partners;
  }

  const orderCashImpact = Math.max(0, Number(order?.pricing?.total) || 0);

  const partnerIds = partners
    .map((partner) => partner?.partnerId)
    .filter((partnerId) => mongoose.Types.ObjectId.isValid(partnerId))
    .map((partnerId) => new mongoose.Types.ObjectId(partnerId));

  if (partnerIds.length === 0) {
    return partners;
  }

  const [cashCollectedAgg, cashDepositsAgg] = await Promise.all([
    FoodOrder.aggregate([
      {
        $match: {
          'dispatch.deliveryPartnerId': { $in: partnerIds },
          orderStatus: 'delivered',
          'payment.method': 'cash',
        },
      },
      {
        $group: {
          _id: '$dispatch.deliveryPartnerId',
          cashCollected: { $sum: { $ifNull: ['$pricing.total', 0] } },
        },
      },
    ]),
    FoodDeliveryCashDeposit.aggregate([
      {
        $match: {
          deliveryPartnerId: { $in: partnerIds },
          status: 'Completed',
        },
      },
      {
        $group: {
          _id: '$deliveryPartnerId',
          depositedCash: { $sum: { $ifNull: ['$amount', 0] } },
        },
      },
    ]),
  ]);

  const cashCollectedMap = new Map(
    (cashCollectedAgg || []).map((entry) => [
      String(entry?._id || ''),
      Number(entry?.cashCollected) || 0,
    ]),
  );
  const cashDepositsMap = new Map(
    (cashDepositsAgg || []).map((entry) => [
      String(entry?._id || ''),
      Number(entry?.depositedCash) || 0,
    ]),
  );

  const eligiblePartners = partners.filter((partner) => {
    const partnerId = String(partner?.partnerId || '');
    const cashCollected = cashCollectedMap.get(partnerId) || 0;
    const depositedCash = cashDepositsMap.get(partnerId) || 0;
    const cashInHand = Math.max(0, cashCollected - depositedCash);
    const projectedCashInHand = cashInHand + orderCashImpact;
    return projectedCashInHand <= totalCashLimit;
  });

  const skippedCount = partners.length - eligiblePartners.length;
  if (skippedCount > 0) {
    logger.info(
      `COD cash-limit filter skipped ${skippedCount} delivery partner(s) for order ${order?._id || ''}.`,
    );
  }

  return eligiblePartners;
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
          'dispatch.assignedAt': { $lt: new Date(Date.now() - lockTimeout) }
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
    const { partners } = await listNearbyOnlineDeliveryPartners(order.restaurantId, searchOptions);
    
    // TIERED ALERT LOGIC
    // Phase 2: Broadcast to all (Attempt 3+)
    // Phase 3: Admin Alert (Attempt 5+ or roughly 5 mins)
    const isPhase3 = attempt >= 6; // ~6 minutes (60s * 6)

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

    const codEligiblePartners = await filterPartnersByCodCashLimit(partners, order);
    const eligible = codEligiblePartners.filter(p => !offeredIds.includes(p.partnerId.toString()));

    if (eligible.length === 0) {
      logger.info(`tryAutoAssign: No NEW eligible partners in ${maxKm}km for order ${order._id}. Restarting hunt...`);
      
      // If we ran out of new eligible partners, we might want to re-offer to everyone (Phase 2 style)
      const io = getIO();
      if (io && codEligiblePartners.length > 0) {
        const payload = buildDeliverySocketPayload(order, order.restaurantId);
        for (const p of codEligiblePartners) {
          const roomName = rooms.delivery(p.partnerId);
          io.to(roomName).emit('new_order_available', { ...payload, pickupDistanceKm: p.distanceKm });
        }
      }

      // Re-queue itself to keep trying
      await addOrderJob({
        action: 'DISPATCH_TIMEOUT_CHECK',
        orderMongoId: order._id.toString(),
        orderId: order._id.toString(),
        attempt: attempt + 1
      }, { delay: 30000 }); // Retry faster (30s) if no one found

      return order;
    }

    const io = getIO();
    const payload = buildDeliverySocketPayload(order, order.restaurantId);

    // BROADCAST: Notify all eligible riders
    logger.info(`Broadcasting order ${order._id} to ${eligible.length} riders.`);
    for (const p of eligible) {
      const roomName = rooms.delivery(p.partnerId);
      if (io) io.to(roomName).emit('new_order', { ...payload, pickupDistanceKm: p.distanceKm });
    }

    // Batch Push Notifications
    const pushTargets = eligible.map(p => ({
      ownerType: 'DELIVERY_PARTNER',
      ownerId: p.partnerId
    }));

    if (pushTargets.length > 0) {
      try {
        await notifyOwnersSafely(
          pushTargets,
          {
            title: 'New order available!',
            body: `Order #${order.order_id || order._id} is available. You have 60 seconds to accept!`,
            data: { type: 'new_order', orderId: order._id.toString() },
          }
        );
      } catch (err) {
        logger.warn(`Push notifications failed for broadcast on order ${order._id}: ${err.message}`);
      }
    }

    const offeredToEntries = eligible.map(p => ({
      partnerId: p.partnerId,
      at: new Date(),
      action: 'offered'
    }));

    order.dispatch.status = 'unassigned';
    order.dispatch.deliveryPartnerId = null;
    order.dispatch.offeredTo.push(...offeredToEntries);
    await order.save();

    // Re-check in 60s
    await addOrderJob({
      action: 'DISPATCH_TIMEOUT_CHECK',
      orderMongoId: order._id.toString(),
      orderId: order._id.toString(),
      attempt: attempt + 1
    }, { delay: 60000 });

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

  order.dispatch.status = 'unassigned';
  order.dispatch.deliveryPartnerId = null;
  order.dispatch.offeredTo = [];
  await order.save();

  await tryAutoAssign(order._id);
  return { success: true };
}
