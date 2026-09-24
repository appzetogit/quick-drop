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

async function getActiveRule(segment) {
    return DriverIncentiveRule.findOne({ segment, isActive: true }).sort({ createdAt: -1 }).lean();
}

async function countCompletedToday(ctx, segment, { start, end }) {
    if (segment === 'taxiAndPorter') {
        if (!ctx.taxiDriverId) return 0;
        return Ride.countDocuments({
            driverId: ctx.taxiDriverId,
            liveStatus: 'completed',
            completedAt: { $gte: start, $lte: end },
        });
    }

    let total = 0;
    if (ctx.foodPartnerId) {
        total += await FoodOrder.countDocuments({
            'dispatch.deliveryPartnerId': ctx.foodPartnerId,
            orderStatus: 'delivered',
            'deliveryState.deliveredAt': { $gte: start, $lte: end },
        });
    }
    if (ctx.qcPartnerId) {
        total += await QCOrder.countDocuments({
            'dispatch.deliveryPartnerId': ctx.qcPartnerId,
            orderStatus: 'delivered',
            'deliveryState.deliveredAt': { $gte: start, $lte: end },
        });
    }
    return total;
}

/**
 * Pays the reward through whichever wallet this rider actually has.
 *
 * A linked (unified) rider is paid through the taxi driver wallet —
 * applyDriverWalletAdjustment — because that is the balance getRiderFinance
 * folds everything into for a unified person. An unlinked, food/QC-only
 * partner has no taxi driver record to credit, so they're paid through a
 * DeliveryBonusTransaction row instead, same as an admin-granted bonus.
 */
async function payReward({ ctx, rule, completedOrders, periodKey }) {
    const description = `${rule.title || 'Daily incentive'} — ${completedOrders}/${rule.targetOrders} completed`;
    const metadata = {
        category: 'daily_order_incentive',
        ruleId: String(rule._id),
        segment: rule.segment,
        periodKey,
    };

    if (ctx.taxiDriverId) {
        await applyDriverWalletAdjustment({
            driverId: ctx.taxiDriverId,
            amount: rule.rewardAmount,
            type: 'adjustment',
            description,
            metadata,
        });
        return 'taxi_driver_wallet';
    }

    const partnerId = ctx.foodPartnerId || ctx.qcPartnerId;
    if (!partnerId) throw new Error('No wallet to credit — rider resolved to neither a driver nor a delivery partner');

    // transactionId doubles as a human-visible reference and, via the
    // schema's unique index, a second idempotency guard alongside
    // DriverIncentiveCredit's own unique index.
    const transactionId = `INC-${periodKey.replace(/-/g, '')}-${String(partnerId).slice(-8)}`;
    await DeliveryBonusTransaction.create({
        deliveryPartnerId: partnerId,
        transactionId,
        amount: rule.rewardAmount,
        reference: description,
    });
    return 'delivery_bonus_transaction';
}

/**
 * Recomputes today's progress and, if the target was just reached and this
 * rider/rule/day hasn't been credited yet, pays the reward.
 *
 * Called from every order/ride completion path. Never throws — a failure
 * here must not fail the delivery or ride the rider just completed; callers
 * fire this with `.catch(logger.warn)`, matching the cashback/referral hooks
 * it sits alongside.
 */
async function maybeCreditIncentive({ startFrom, id, segment }) {
    try {
        const ctx = await resolveDriverContext({ startFrom, id });
        if (!ctx) return;

        const rule = await getActiveRule(segment);
        if (!rule) return;

        const { start, end, periodKey } = istDayBounds();
        const completedOrders = await countCompletedToday(ctx, segment, { start, end });
        if (completedOrders < rule.targetOrders) return;

        // Insert the credit row FIRST — its unique index is what makes this
        // idempotent under a race (two orders completing back to back). Only
        // the insert that actually wins pays the reward.
        let creditRow;
        try {
            creditRow = await DriverIncentiveCredit.create({
                driverKey: ctx.driverKey,
                ruleId: rule._id,
                segment,
                periodKey,
                completedOrders,
                rewardAmount: rule.rewardAmount,
                creditedVia: ctx.taxiDriverId ? 'taxi_driver_wallet' : 'delivery_bonus_transaction',
            });
        } catch (err) {
            if (err?.code === 11000) return; // already credited for today
            throw err;
        }

        const creditedVia = await payReward({ ctx, rule, completedOrders, periodKey });
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
                    body: `You completed ${rule.targetOrders} orders today and earned ₹${rule.rewardAmount}.`,
                    data: { type: 'incentive_credited', ruleId: String(rule._id), amount: String(rule.rewardAmount) },
                },
            ).catch(() => {});
        }
    } catch (err) {
        logger.warn(`incentive progress hook failed: ${err?.message || err}`);
    }
}

/** Called after a food or quick-commerce order is marked delivered. */
export function onFoodOrQuickCommerceOrderCompleted({ deliveryPartnerId, vertical }) {
    return maybeCreditIncentive({
        startFrom: vertical === 'quickCommerce' ? 'qcPartner' : 'foodPartner',
        id: deliveryPartnerId,
        segment: 'foodAndQuick',
    });
}

/** Called after a taxi ride (including a parcel/porter job) is completed. */
export function onTaxiRideCompleted({ driverId }) {
    return maybeCreditIncentive({ startFrom: 'taxiDriver', id: driverId, segment: 'taxiAndPorter' });
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
    const rule = await getActiveRule(segment);
    if (!rule) return null;

    const { start, end, periodKey } = istDayBounds();
    const completedOrders = await countCompletedToday(ctx, segment, { start, end });
    const credit = await DriverIncentiveCredit.findOne({
        driverKey: ctx.driverKey,
        ruleId: rule._id,
        periodKey,
    })
        .select('_id')
        .lean();

    return {
        id: String(rule._id),
        title: rule.title || `Complete ${rule.targetOrders} orders, get ₹${rule.rewardAmount}`,
        targetOrders: rule.targetOrders,
        completedOrders: Math.min(completedOrders, rule.targetOrders),
        rewardAmount: rule.rewardAmount,
        expiresAt: end.toISOString(),
        rewardCredited: Boolean(credit),
    };
}

export const __testables = { istDayBounds, resolveDriverContext };
