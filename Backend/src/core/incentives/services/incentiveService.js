import mongoose from 'mongoose';
import { FoodDeliveryPartner } from '../../../modules/food/delivery/models/deliveryPartner.model.js';
import { FoodDeliveryPartner as QCDeliveryPartner } from '../../../modules/quickCommerce/modules/food/delivery/models/deliveryPartner.model.js';
import { FoodOrder } from '../../../modules/food/orders/models/order.model.js';
import { FoodOrder as QCOrder } from '../../../modules/quickCommerce/modules/food/orders/models/order.model.js';
import { Driver } from '../../../modules/taxi/driver/models/Driver.js';
import { Ride } from '../../../modules/taxi/user/models/Ride.js';
import { DriverIncentiveRule } from '../models/driverIncentiveRule.model.js';
import { DriverIncentiveCredit } from '../models/driverIncentiveCredit.model.js';
import { DeliveryBonusTransaction } from '../../../modules/food/admin/models/deliveryBonusTransaction.model.js';
import { applyDriverWalletAdjustment } from '../../../modules/taxi/driver/services/walletService.js';
import { notifyOwnerSafely } from '../../notifications/firebase.service.js';
import { logger } from '../../../utils/logger.js';

// Same convention as driverTodaySummaryService.js's toIstDayKey — this
// product is India-only, and a rider's "today" is their IST calendar day
// regardless of which timezone the server process happens to run in.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayBounds(at = new Date()) {
    const ist = new Date(at.getTime() + IST_OFFSET_MS);
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth();
    const d = ist.getUTCDate();
    const startUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MS;
    const endUtcMs = Date.UTC(y, m, d, 23, 59, 59, 999) - IST_OFFSET_MS;
    return {
        start: new Date(startUtcMs),
        end: new Date(endUtcMs),
        periodKey: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    };
}

/**
 * Resolves the caller's unified identity from any one of its three possible
 * starting points, so a food order, a QC order and a ride all agree on the
 * same rider for progress-counting and credit idempotency.
 *
 * `driverKey` is what DriverIncentiveCredit dedupes on. A linked (unified)
 * rider always resolves to the SAME driverKey regardless of which vertical's
 * completion event triggered the call — that's the whole point of following
 * the link — while an unlinked rider only ever has one identity to begin
 * with, so their own id is stable on its own.
 */
async function resolveDriverContext({ startFrom, id }) {
    let foodPartnerId = null;
    let qcPartnerId = null;
    let driver = null;

    if (startFrom === 'taxiDriver') {
        driver = await Driver.findById(id)
            .select('workMode legacyDeliveryPartnerId legacyQcPartnerId')
            .lean();
        if (!driver) return null;
        foodPartnerId = driver.legacyDeliveryPartnerId || null;
        qcPartnerId = driver.legacyQcPartnerId || null;
    } else {
        const PartnerModel = startFrom === 'qcPartner' ? QCDeliveryPartner : FoodDeliveryPartner;
        const partner = await PartnerModel.findById(id).select('driverId').lean();
        if (!partner) return null;
        if (startFrom === 'qcPartner') qcPartnerId = partner._id;
        else foodPartnerId = partner._id;

        if (partner.driverId) {
            driver = await Driver.findById(partner.driverId)
                .select('workMode legacyDeliveryPartnerId legacyQcPartnerId')
                .lean();
            if (driver) {
                foodPartnerId = foodPartnerId || driver.legacyDeliveryPartnerId || null;
                qcPartnerId = qcPartnerId || driver.legacyQcPartnerId || null;
            }
        }
    }

    const taxiDriverId = driver?._id || null;
    const driverKey = taxiDriverId
        ? `driver:${taxiDriverId}`
        : foodPartnerId
            ? `foodPartner:${foodPartnerId}`
            : `qcPartner:${qcPartnerId}`;

    return {
        driverKey,
        foodPartnerId,
        qcPartnerId,
        taxiDriverId,
        // Only meaningful when a unified driver was actually found — the
        // read path uses it to guess which segment to show before the rider
        // has completed anything today. See getCurrentIncentiveForFoodPartner.
        workMode: driver?.workMode || null,
    };
}

const asId = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);

/** The live ladder for a segment: one zone's own, or (zoneId null) the default. */
async function getActiveRule(segment, zoneId = null) {
    return DriverIncentiveRule.findOne({ segment, zoneId: asId(zoneId), isActive: true })
        .sort({ createdAt: -1 })
        .lean();
}

/**
 * Which ladder an order or ride in `zoneId` climbs, and which of the rider's
 * trips count toward it.
 *
 * A zone with its own ladder counts only that zone's trips: six orders in
 * Indore climb Indore's ladder, three in Dewas climb Dewas's. Every other trip
 * climbs the default ladder, which counts trips outside the zones that have
 * their own -- so no trip counts twice and none is lost.
 *
 * @returns {Promise<{rule: object|null, scope: {onlyZone?: ObjectId, excludeZones?: ObjectId[]}}>}
 */
async function ladderFor(segment, zoneId) {
    const own = await DriverIncentiveRule.distinct('zoneId', { segment, isActive: true, zoneId: { $ne: null } });
    const id = asId(zoneId);
    if (id && own.some((z) => String(z) === String(id))) {
        return { rule: await getActiveRule(segment, id), scope: { onlyZone: id } };
    }
    return { rule: await getActiveRule(segment, null), scope: { excludeZones: own } };
}

/** Mongo filter narrowing a food/quick order count to the ladder's zones. */
function orderZoneFilter(scope = {}) {
    if (scope.onlyZone) return { zoneId: scope.onlyZone };
    if (scope.excludeZones?.length) return { zoneId: { $nin: scope.excludeZones } };
    return {};
}

/** The same for rides: taxi rides store no zone, so their pickup is tested against it. */
async function rideZoneFilter(scope = {}) {
    const ids = scope.onlyZone ? [scope.onlyZone] : scope.excludeZones || [];
    if (!ids.length) return {};
    const { Zone } = await import('../../../modules/taxi/driver/models/Zone.js');
    const zones = await Zone.find({ _id: { $in: ids } }).select('geometry').lean();
    const within = zones
        .filter((z) => z?.geometry?.coordinates?.length)
        .map((z) => ({ pickupLocation: { $geoWithin: { $geometry: z.geometry } } }));
    // A zone ladder whose zone has no shape matches nothing.
    if (scope.onlyZone) return within.length ? within[0] : { _id: null };
    return within.length ? { $nor: within } : {};
}

/**
 * Rule's tiers, ascending by the order count that unlocks them. A rule saved
 * before tiers existed (one targetOrders/rewardAmount, no `tiers`) reads as a
 * one-rung ladder keyed by the rule's own id, so it keeps paying riders.
 */
export function tiersOfRule(rule) {
    if (Array.isArray(rule?.tiers) && rule.tiers.length) return rule.tiers;
    if (Number(rule?.targetOrders) > 0) {
        return [{ _id: rule._id, fromOrders: 1, toOrders: Number(rule.targetOrders), rewardAmount: Number(rule.rewardAmount) || 0 }];
    }
    return [];
}

function sortedTiersOf(rule) {
    return [...tiersOfRule(rule)].sort((a, b) => a.toOrders - b.toOrders);
}

async function countCompletedToday(ctx, segment, { start, end }, scope = {}) {
    if (segment === 'taxiAndPorter') {
        if (!ctx.taxiDriverId) return 0;
        return Ride.countDocuments({
            driverId: ctx.taxiDriverId,
            liveStatus: 'completed',
            completedAt: { $gte: start, $lte: end },
            ...(await rideZoneFilter(scope)),
        });
    }

    const zone = orderZoneFilter(scope);
    let total = 0;
    if (ctx.foodPartnerId) {
        total += await FoodOrder.countDocuments({
            'dispatch.deliveryPartnerId': ctx.foodPartnerId,
            orderStatus: 'delivered',
            'deliveryState.deliveredAt': { $gte: start, $lte: end },
            ...zone,
        });
    }
    if (ctx.qcPartnerId) {
        total += await QCOrder.countDocuments({
            'dispatch.deliveryPartnerId': ctx.qcPartnerId,
            orderStatus: 'delivered',
            'deliveryState.deliveredAt': { $gte: start, $lte: end },
            ...zone,
        });
    }
    return total;
}

/**
 * Pays one tier's reward through whichever wallet this rider actually has.
 *
 * A linked (unified) rider is paid through the taxi driver wallet —
 * applyDriverWalletAdjustment — because that is the balance getRiderFinance
 * folds everything into for a unified person. An unlinked, food/QC-only
 * partner has no taxi driver record to credit, so they're paid through a
 * DeliveryBonusTransaction row instead, same as an admin-granted bonus.
 */
async function payTierReward({ ctx, rule, tier, completedOrders, periodKey }) {
    const description =
        `${rule.title || 'Daily incentive'} — tier ${tier.fromOrders}-${tier.toOrders} ` +
        `(${completedOrders} completed today)`;
    const metadata = {
        category: 'daily_order_incentive',
        ruleId: String(rule._id),
        tierId: String(tier._id),
        segment: rule.segment,
        periodKey,
    };

    if (ctx.taxiDriverId) {
        await applyDriverWalletAdjustment({
            driverId: ctx.taxiDriverId,
            amount: tier.rewardAmount,
            type: 'adjustment',
            description,
            metadata,
        });
        return 'taxi_driver_wallet';
    }

    const partnerId = ctx.foodPartnerId || ctx.qcPartnerId;
    if (!partnerId) throw new Error('No wallet to credit — rider resolved to neither a driver nor a delivery partner');

    // Unique per (day, tier, partner) — via the schema's unique index, a
    // second idempotency guard alongside DriverIncentiveCredit's own one.
    const transactionId =
        `INC-${periodKey.replace(/-/g, '')}-${String(tier._id).slice(-6)}-${String(partnerId).slice(-6)}`;
    await DeliveryBonusTransaction.create({
        deliveryPartnerId: partnerId,
        transactionId,
        amount: tier.rewardAmount,
        reference: description,
    });
    return 'delivery_bonus_transaction';
}

/**
 * Recomputes today's progress and pays every tier the rider has newly
 * reached and hasn't already been credited for today.
 *
 * A rule is a ladder (1-5 → ₹100, 5-10 → ₹150, 10-15 → ₹200, ...), so more
 * than one rung can be due in a single call — a bulk backfill, or a tier
 * whose threshold was low enough that yesterday's last order and today's
 * first already cleared it. Each tier is credited independently and
 * idempotently; a tier already paid today is simply skipped.
 *
 * Called from every order/ride completion path. Never throws — a failure
 * here must not fail the delivery or ride the rider just completed; callers
 * fire this with `.catch(logger.warn)`, matching the cashback/referral hooks
 * it sits alongside.
 */
async function maybeCreditIncentive({ startFrom, id, segment, zoneId = null }) {
    try {
        const ctx = await resolveDriverContext({ startFrom, id });
        if (!ctx) return;

        // The zone's own ladder when it has one, else the default (ladderFor).
        const { rule, scope } = await ladderFor(segment, zoneId);
        const tiers = sortedTiersOf(rule);
        if (tiers.length === 0) return;

        const { start, end, periodKey } = istDayBounds();
        const completedOrders = await countCompletedToday(ctx, segment, { start, end }, scope);

        const dueTiers = tiers.filter((t) => completedOrders >= t.toOrders);
        if (dueTiers.length === 0) return;

        for (const tier of dueTiers) {
            let creditRow;
            try {
                creditRow = await DriverIncentiveCredit.create({
                    driverKey: ctx.driverKey,
                    ruleId: rule._id,
                    tierId: tier._id,
                    segment,
                    periodKey,
                    completedOrders,
                    rewardAmount: tier.rewardAmount,
                    creditedVia: ctx.taxiDriverId ? 'taxi_driver_wallet' : 'delivery_bonus_transaction',
                });
            } catch (err) {
                if (err?.code === 11000) continue; // this tier was already credited today
                throw err;
            }

            const creditedVia = await payTierReward({ ctx, rule, tier, completedOrders, periodKey });
            if (creditedVia !== creditRow.creditedVia) {
                await DriverIncentiveCredit.updateOne({ _id: creditRow._id }, { $set: { creditedVia } });
            }

            // notifyOwnerSafely's DELIVERY_PARTNER type only resolves against the
            // food-vertical partner collection, not the QC one — so a QC-only,
            // unlinked rider (ctx.foodPartnerId null) quietly gets no push here.
            // The wallet credit above is unaffected either way.
            if (ctx.foodPartnerId) {
                notifyOwnerSafely(
                    { ownerType: 'DELIVERY_PARTNER', ownerId: ctx.foodPartnerId },
                    {
                        title: 'Incentive unlocked! 🎉',
                        body: `You completed ${tier.toOrders} orders today and earned ₹${tier.rewardAmount}.`,
                        data: {
                            type: 'incentive_credited',
                            ruleId: String(rule._id),
                            tierId: String(tier._id),
                            amount: String(tier.rewardAmount),
                        },
                    },
                ).catch(() => {});
            }
        }
    } catch (err) {
        logger.warn(`incentive progress hook failed: ${err?.message || err}`);
    }
}

/** Called after a food or quick-commerce order is marked delivered. */
export function onFoodOrQuickCommerceOrderCompleted({ deliveryPartnerId, vertical, zoneId = null }) {
    return maybeCreditIncentive({
        startFrom: vertical === 'quickCommerce' ? 'qcPartner' : 'foodPartner',
        id: deliveryPartnerId,
        segment: 'foodAndQuick',
        zoneId,
    });
}

/** Called after a taxi ride (including a parcel/porter job) is completed. */
export async function onTaxiRideCompleted({ driverId, ride = null }) {
    const { taxiZoneIdOfRide } = await import('../../zones/taxiZone.js');
    const zoneId = ride ? await taxiZoneIdOfRide(ride) : null;
    return maybeCreditIncentive({ startFrom: 'taxiDriver', id: driverId, segment: 'taxiAndPorter', zoneId });
}

/**
 * The zone the rider is working in now, for the home-screen card: the zone of
 * their latest trip. Null when they have none, which shows the default ladder.
 */
async function currentZoneOf(ctx, segment) {
    if (segment === 'taxiAndPorter') {
        if (!ctx.taxiDriverId) return null;
        const last = await Ride.findOne({ driverId: ctx.taxiDriverId }).sort({ createdAt: -1 }).select('pickupLocation').lean();
        if (!last) return null;
        const { taxiZoneIdOfRide } = await import('../../zones/taxiZone.js');
        return taxiZoneIdOfRide(last);
    }
    const latest = await Promise.all([
        ctx.foodPartnerId
            ? FoodOrder.findOne({ 'dispatch.deliveryPartnerId': ctx.foodPartnerId }).sort({ updatedAt: -1 }).select('zoneId updatedAt').lean()
            : null,
        ctx.qcPartnerId
            ? QCOrder.findOne({ 'dispatch.deliveryPartnerId': ctx.qcPartnerId }).sort({ updatedAt: -1 }).select('zoneId updatedAt').lean()
            : null,
    ]);
    const newest = latest.filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    return newest?.zoneId || null;
}

/**
 * The rider-facing read path: what to show on the home-screen card right
 * now, for whichever segment this rider is currently working.
 *
 * Segment guess for a linked rider: the server has no separate "quick
 * commerce toggle" signal today (see DutySegment.resolve in the Flutter app
 * for the fuller client-side rule this approximates), so a 'taxi' or 'all'
 * workMode is treated as the taxi segment and anything else as food/QC —
 * the same fallback the client itself uses.
 */
export async function getCurrentIncentiveForFoodPartner(foodPartnerId) {
    const ctx = await resolveDriverContext({ startFrom: 'foodPartner', id: foodPartnerId });
    if (!ctx) return null;

    const segment = ctx.workMode === 'taxi' || ctx.workMode === 'all' ? 'taxiAndPorter' : 'foodAndQuick';
    const { rule, scope } = await ladderFor(segment, await currentZoneOf(ctx, segment));
    const tiers = sortedTiersOf(rule);
    if (tiers.length === 0) return null;

    const { start, end, periodKey } = istDayBounds();
    const completedOrders = await countCompletedToday(ctx, segment, { start, end }, scope);

    const creditedRows = await DriverIncentiveCredit.find({ driverKey: ctx.driverKey, ruleId: rule._id, periodKey })
        .select('tierId')
        .lean();
    const creditedTierIds = new Set(creditedRows.map((r) => String(r.tierId)));

    const finalTier = tiers[tiers.length - 1];
    const totalRewardAmount = tiers.reduce((sum, t) => sum + t.rewardAmount, 0);

    return {
        id: String(rule._id),
        title: rule.title || `Complete ${finalTier.toOrders} orders, get ₹${totalRewardAmount}`,
        tiers: tiers.map((t) => ({
            id: String(t._id),
            fromOrders: t.fromOrders,
            toOrders: t.toOrders,
            rewardAmount: t.rewardAmount,
            achieved: completedOrders >= t.toOrders,
            credited: creditedTierIds.has(String(t._id)),
        })),
        completedOrders,
        // Convenience fields for a simple display: the ladder's last rung and
        // what every rung together pays out.
        targetOrders: finalTier.toOrders,
        totalRewardAmount,
        expiresAt: end.toISOString(),
    };
}

export const __testables = { istDayBounds, resolveDriverContext, sortedTiersOf, ladderFor, countCompletedToday };
