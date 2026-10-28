/**
 * Who pays the GST on a restaurant's food: Master > Restaurant GST.
 *
 * `gstPayout` on the restaurant, admin-only:
 *   'platform'   -- the restaurant is paid without the GST; the platform remits it.
 *   'restaurant' -- the GST is paid to the restaurant with its payout; it files it.
 *
 * The ledger reads it once per order (orders/services/foodTransaction.service.js),
 * so a change applies to orders placed after it and never rewrites one already
 * placed. 'restaurant' needs a GSTIN on file: paying GST to someone who cannot
 * file it would just lose it.
 *
 * GST totals for filing: over a date range, the GST on delivered orders' food,
 * split into what the platform owes and what was paid to restaurants. The food
 * GST of an order is read from its stored bill (shared/restaurantPayout.js), the
 * same figure the restaurant's bill shows.
 */
import mongoose from 'mongoose';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { buildRestaurantPayoutBreakdown } from '../../shared/restaurantPayout.js';

export const GST_PAYOUT_OPTIONS = Object.freeze(['platform', 'restaurant']);

export class GstPayoutError extends Error {}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hasGstin = (r) => String(r?.gstNumber || '').trim().length > 0;

const describe = (r) => ({
    restaurantId: String(r._id),
    restaurantName: r.restaurantName || '',
    status: r.status || '',
    gstRegistered: r.gstRegistered === true,
    gstNumber: String(r.gstNumber || '').trim(),
    gstPayout: r.gstPayout === 'restaurant' ? 'restaurant' : 'platform',
    updatedAt: r.gstPayoutUpdatedAt || null,
    updatedBy: r.gstPayoutUpdatedBy || '',
});

const SELECT = 'restaurantName status gstRegistered gstNumber gstPayout gstPayoutUpdatedAt gstPayoutUpdatedBy';

export async function listRestaurantGst() {
    const rows = await FoodRestaurant.find({}).select(SELECT).sort({ restaurantName: 1 }).lean();
    return rows.map(describe);
}

export async function setRestaurantGstPayout(restaurantId, value, { actor = 'admin' } = {}) {
    if (!mongoose.Types.ObjectId.isValid(String(restaurantId || ''))) throw new GstPayoutError('Invalid restaurant');
    const gstPayout = String(value || '').trim();
    if (!GST_PAYOUT_OPTIONS.includes(gstPayout)) throw new GstPayoutError('Choose who pays the GST: platform or restaurant.');
    const restaurant = await FoodRestaurant.findById(restaurantId).select(SELECT).lean();
    if (!restaurant) throw new GstPayoutError('Restaurant not found');
    if (gstPayout === 'restaurant' && !hasGstin(restaurant)) {
        throw new GstPayoutError(
            `${restaurant.restaurantName || 'This restaurant'} has no GSTIN saved, so it cannot file GST. `
            + 'Add its GST number under Edit Restaurant > Documents first.',
        );
    }
    const updated = await FoodRestaurant.findByIdAndUpdate(
        restaurantId,
        { $set: { gstPayout, gstPayoutUpdatedAt: new Date(), gstPayoutUpdatedBy: String(actor || 'admin').slice(0, 120) } },
        { new: true },
    ).select(SELECT).lean();
    return describe(updated);
}

/**
 * GST on food for delivered orders placed in [from, to]: total, owed by the
 * platform, and paid to restaurants -- overall and per restaurant.
 */
export async function gstTotals({ from, to } = {}) {
    const start = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const end = to ? new Date(to) : new Date();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
        throw new GstPayoutError('Choose a valid date range.');
    }
    const [{ FoodTransaction }, { FoodOrder }] = await Promise.all([
        import('../../orders/models/foodTransaction.model.js'),
        import('../../orders/models/order.model.js'),
    ]);
    const orders = await FoodOrder.find({ orderStatus: 'delivered', createdAt: { $gte: start, $lte: end } })
        .select('restaurantId pricing')
        .lean();
    const txByOrder = new Map(
        (await FoodTransaction.find({ orderId: { $in: orders.map((o) => o._id) } })
            .select('orderId amounts.restaurantGstPassThrough')
            .lean())
            .map((t) => [String(t.orderId), Number(t.amounts?.restaurantGstPassThrough) || 0]),
    );
    const names = new Map(
        (await FoodRestaurant.find({ _id: { $in: [...new Set(orders.map((o) => String(o.restaurantId)))] } })
            .select('restaurantName')
            .lean())
            .map((r) => [String(r._id), r.restaurantName || '']),
    );

    const per = new Map();
    const total = { orders: 0, gstOnFood: 0, paidToRestaurants: 0, owedByPlatform: 0 };
    for (const o of orders) {
        const gst = Number(buildRestaurantPayoutBreakdown(o).gstOnFood) || 0;
        const toRestaurant = Math.min(gst, txByOrder.get(String(o._id)) || 0);
        const key = String(o.restaurantId);
        const row = per.get(key) || { restaurantId: key, restaurantName: names.get(key) || '', orders: 0, gstOnFood: 0, paidToRestaurant: 0, owedByPlatform: 0 };
        row.orders += 1;
        row.gstOnFood += gst;
        row.paidToRestaurant += toRestaurant;
        row.owedByPlatform += gst - toRestaurant;
        per.set(key, row);
        total.orders += 1;
        total.gstOnFood += gst;
        total.paidToRestaurants += toRestaurant;
        total.owedByPlatform += gst - toRestaurant;
    }
    const fix = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && k !== 'orders' ? round2(v) : v]));
    return {
        from: start.toISOString(),
        to: end.toISOString(),
        total: fix(total),
        restaurants: [...per.values()].map(fix).sort((a, b) => b.gstOnFood - a.gstOnFood),
    };
}
