import mongoose from 'mongoose';
import { FoodOrder } from '../../orders/models/order.model.js';
import { FoodTransaction } from '../../orders/models/foodTransaction.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodRestaurantWithdrawal } from '../../restaurant/models/foodRestaurantWithdrawal.model.js';
import { buildRestaurantPayoutBreakdown } from '../../shared/restaurantPayout.js';
import { FoodAdmin } from '../../../../core/admin/admin.model.js';
import { withFinanceLock, restaurantWithdrawalLockKey } from '../../../../core/finance/financeLock.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { FoodRestaurantSettlement } from './settlement.model.js';

/**
 * Admin > Food > Restaurant settlement.
 *
 * Every restaurant is settled per 10-day cycle: 1-10, 11-20 and 21 to the
 * month's end, in India time. A cycle's bills are its delivered orders, each
 * read from the payout ledger (food_transactions), so a bill here is the same
 * money the restaurant's app shows:
 *
 *   Bill total = basic (food before GST) + packing + GST on the bill
 *   Payable    = bill total - commission - deductions
 *
 * Deductions are only ever: the food's GST when the platform pays it to the
 * government for this restaurant (Master > Restaurant GST), and a coupon the
 * restaurant itself funded. For a restaurant paid its GST with no coupons they
 * are 0 and payable is bill total minus commission. GST on commission is not
 * part of this screen.
 *
 * Paying a cycle locks its bills under one settlement number. Each payment is
 * also written to the restaurant's wallet as an approved withdrawal, so the
 * restaurant's own balance falls by what was paid and the same earnings cannot
 * be withdrawn or paid again. A payment can never exceed what the cycle still
 * owes, nor the restaurant's unpaid earnings across all its orders (money
 * already paid out through withdrawals stays paid).
 */

const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const IST_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const PAYMENT_MODES = ['upi', 'bank_transfer', 'cash'];
const PAID_STATUSES = ['captured', 'authorized'];

/* ------------------------------------------------------------------ */
/* Cycles                                                              */
/* ------------------------------------------------------------------ */

const istMidnight = (y, m0, d) => new Date(Date.UTC(y, m0, d) - IST_MS);
const daysIn = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** The cycle of a month: 1 = 1-10, 2 = 11-20, 3 = 21-end. */
export function cycleWindow(year, month, cycle) {
    const y = Number(year);
    const m = Number(month);
    const c = Number(cycle);
    if (!Number.isInteger(y) || y < 2020 || y > 2100) throw new ValidationError('Pick a year');
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new ValidationError('Pick a month');
    if (![1, 2, 3].includes(c)) throw new ValidationError('Pick a payment cycle');
    const m0 = m - 1;
    const firstDay = (c - 1) * 10 + 1;
    const lastDay = c === 3 ? daysIn(y, m0) : c * 10;
    return {
        year: y,
        month: m,
        cycle: c,
        key: `${y}-${String(m).padStart(2, '0')}-${c}`,
        start: istMidnight(y, m0, firstDay),
        end: new Date(istMidnight(y, m0, lastDay + 1).getTime() - 1),
        label: `${firstDay}–${lastDay} ${MONTHS[m0]} ${y}`,
        firstDay,
        lastDay,
    };
}

/** The cycle a date falls in. */
export function cycleOf(date = new Date()) {
    const d = new Date(new Date(date).getTime() + IST_MS);
    const day = d.getUTCDate();
    return cycleWindow(d.getUTCFullYear(), d.getUTCMonth() + 1, day <= 10 ? 1 : day <= 20 ? 2 : 3);
}

const settlementNoOf = (w, restaurantId) =>
    `STL-${String(w.year).slice(-2)}${String(w.month).padStart(2, '0')}-C${w.cycle}-${String(restaurantId).slice(-5).toUpperCase()}`;

/* ------------------------------------------------------------------ */
/* Bills                                                               */
/* ------------------------------------------------------------------ */

/** One delivered order as a settlement bill line, from its ledger row. */
export function billLine(order, tx) {
    const gstPaid = Number(tx?.amounts?.restaurantGstPassThrough) || 0;
    const b = buildRestaurantPayoutBreakdown(order || {}, { gstPaidToRestaurant: gstPaid });
    const basic = round2(b.taxableFoodValue);
    const packing = round2(b.packagingCharge);
    const gst = round2(b.gstOnFood);
    const billTotal = round2(basic + packing + gst);
    const commission = round2(tx?.amounts?.restaurantCommission ?? b.commissionAmount);
    const payable = round2(tx?.amounts?.restaurantShare ?? b.payout);
    return {
        orderId: order._id,
        orderNo: String(order.orderId || ''),
        orderDate: order.createdAt,
        basic,
        packing,
        gst,
        billTotal,
        commission,
        deductions: round2(billTotal - commission - payable),
        payable,
        paymentMethod: String(tx?.paymentMethod || order?.payment?.method || ''),
    };
}

/** Delivered orders of the period with a payout ledger row, as bill lines. */
async function billsInWindow(w, restaurantId = null) {
    const filter = { orderStatus: 'delivered', createdAt: { $gte: w.start, $lte: w.end } };
    if (restaurantId) filter.restaurantId = oid(restaurantId);
    const orders = await FoodOrder.find(filter)
        .select('orderId restaurantId createdAt pricing payment orderStatus')
        .sort({ createdAt: 1 })
        .lean();
    if (!orders.length) return [];
    const txs = await FoodTransaction.find({ orderId: { $in: orders.map((o) => o._id) }, status: { $in: PAID_STATUSES } })
        .select('orderId amounts paymentMethod status')
        .lean();
    const txByOrder = new Map(txs.map((t) => [String(t.orderId), t]));
    return orders
        .filter((o) => txByOrder.has(String(o._id)))
        .map((o) => ({ restaurantId: String(o.restaurantId), ...billLine(o, txByOrder.get(String(o._id))) }));
}

function totalsOf(lines) {
    const t = { orders: lines.length, basic: 0, packing: 0, gst: 0, billTotal: 0, commission: 0, deductions: 0, payable: 0 };
    for (const l of lines) for (const k of ['basic', 'packing', 'gst', 'billTotal', 'commission', 'deductions', 'payable']) t[k] += Number(l[k]) || 0;
    for (const k of Object.keys(t)) if (k !== 'orders') t[k] = round2(t[k]);
    return t;
}

/** What a settlement still owes: its bills, plus what it brought in, less what it paid or moved on. */
const balanceOf = (s) => round2((s?.totals?.payable || 0) + (s?.carriedIn || 0) - (s?.paid || 0) - (s?.carriedOut || 0));

function statusOf(s, balance) {
    if (!s) return balance > 0 ? 'pending' : 'nothing';
    if (s.carriedTo) return 'carried_forward';
    if (s.onHold) return 'on_hold';
    if (balance <= 0.009) return 'paid';
    return s.paid > 0 ? 'partial' : 'pending';
}

/** Orders already locked into some settlement, out of these. */
async function lockedOrderIds(orderIds) {
    if (!orderIds.length) return new Set();
    const rows = await FoodRestaurantSettlement.aggregate([
        { $match: { 'lines.orderId': { $in: orderIds } } },
        { $unwind: '$lines' },
        { $match: { 'lines.orderId': { $in: orderIds } } },
        { $project: { _id: 0, id: '$lines.orderId' } },
    ]);
    return new Set(rows.map((r) => String(r.id)));
}

const describePayment = (p) => ({
    id: String(p._id),
    amount: p.amount,
    mode: p.mode,
    utr: p.utr,
    paidOn: p.paidOn,
    officerName: p.officerName,
    note: p.note,
    recordedBy: p.recordedBy?.name || '',
    recordedAt: p.recordedAt,
});

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listRestaurants() {
    const rows = await FoodRestaurant.find({}).select('restaurantName status city area').sort({ restaurantName: 1 }).lean();
    return rows.map((r) => ({ id: String(r._id), name: r.restaurantName || 'Unnamed', status: r.status || '', city: r.city || r.area || '' }));
}

export async function listOfficers() {
    const rows = await FoodAdmin.find({ isActive: { $ne: false } }).select('name email').sort({ name: 1 }).lean();
    return rows.map((a) => ({ id: String(a._id), name: a.name || a.email || 'Admin' }));
}

/** Unpaid balances of earlier settlements of this restaurant that are not on hold. */
async function earlierOpen(restaurantId, beforeKey) {
    const rows = await FoodRestaurantSettlement.find({ restaurantId: oid(restaurantId), cycleKey: { $lt: beforeKey }, carriedTo: '' })
        .select('settlementNo cycleKey label totals carriedIn carriedOut paid onHold')
        .sort({ cycleKey: 1 })
        .lean();
    return rows.map((s) => ({ settlementNo: s.settlementNo, label: s.label, cycleKey: s.cycleKey, onHold: s.onHold, balance: balanceOf(s) }))
        .filter((s) => s.balance > 0.009);
}

/**
 * One restaurant, one cycle: the bills (locked ones and any not yet locked),
 * the totals, the payments, and what the restaurant can still be paid.
 */
export async function getCycle({ restaurantId, year, month, cycle } = {}) {
    if (!isId(restaurantId)) throw new ValidationError('Pick a restaurant');
    const w = cycleWindow(year, month, cycle);
    const restaurant = await FoodRestaurant.findById(restaurantId).select('restaurantName gstNumber city').lean();
    if (!restaurant) throw new ValidationError('Restaurant not found');
    const settlement = await FoodRestaurantSettlement.findOne({ restaurantId: oid(restaurantId), cycleKey: w.key }).lean();

    const live = await billsInWindow(w, restaurantId);
    const lockedHere = new Set((settlement?.lines || []).map((l) => String(l.orderId)));
    const elsewhere = await lockedOrderIds(live.filter((l) => !lockedHere.has(String(l.orderId))).map((l) => l.orderId));
    const unlocked = live.filter((l) => !lockedHere.has(String(l.orderId)) && !elsewhere.has(String(l.orderId)));

    const lines = [
        ...(settlement?.lines || []).map((l) => ({ ...l, locked: true })),
        ...unlocked.map((l) => ({ ...l, locked: false })),
    ].sort((a, b) => new Date(a.orderDate) - new Date(b.orderDate));
    const totals = totalsOf(lines);
    const paid = round2(settlement?.paid || 0);
    const carriedIn = round2(settlement?.carriedIn || 0);
    const carriedOut = round2(settlement?.carriedOut || 0);
    const balance = round2(totals.payable + carriedIn - paid - carriedOut);
    // Earlier unpaid balances join this settlement when it is first paid.
    const earlier = settlement ? [] : await earlierOpen(restaurantId, w.key);
    const willCarry = round2(earlier.filter((e) => !e.onHold).reduce((s, e) => s + e.balance, 0));

    const { getRestaurantPayoutPosition } = await import('../../restaurant/services/restaurantFinance.service.js');
    const position = await getRestaurantPayoutPosition(restaurantId);
    const pendingRequests = await FoodRestaurantWithdrawal.find({ restaurantId: oid(restaurantId), status: 'pending' })
        .select('amount autoCreated autoCycleLabel createdAt').lean();

    return {
        restaurant: { id: String(restaurant._id), name: restaurant.restaurantName || '', gstNumber: restaurant.gstNumber || '', city: restaurant.city || '' },
        cycle: { key: w.key, label: w.label, year: w.year, month: w.month, cycle: w.cycle, start: w.start, end: w.end, closed: Date.now() > w.end.getTime() },
        settlement: settlement
            ? {
                id: String(settlement._id),
                settlementNo: settlement.settlementNo,
                lockedAt: settlement.lockedAt,
                lockedBy: settlement.lockedBy?.name || '',
                onHold: settlement.onHold,
                holdNote: settlement.holdNote,
                carriedFrom: settlement.carriedFrom,
                carriedTo: settlement.carriedTo,
            }
            : null,
        settlementNo: settlement?.settlementNo || settlementNoOf(w, restaurantId),
        lines,
        unlockedCount: unlocked.length,
        totals,
        carriedIn: settlement ? carriedIn : willCarry,
        carriedInPreview: !settlement && willCarry > 0,
        earlierOpen: earlier,
        carriedOut,
        paid,
        balance: settlement ? balance : round2(balance + willCarry),
        status: statusOf(settlement, settlement ? balance : round2(balance + willCarry)),
        payments: (settlement?.payments || []).map(describePayment).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt)),
        wallet: {
            unpaidEarnings: position.unpaid,
            pendingRequests: pendingRequests.map((r) => ({ amount: r.amount, automatic: r.autoCreated === true, label: r.autoCycleLabel || '', createdAt: r.createdAt })),
        },
    };
}

/** Every restaurant with bills in a cycle, with its settlement state. */
export async function cycleOverview({ year, month, cycle } = {}) {
    const w = cycleWindow(year, month, cycle);
    const bills = await billsInWindow(w);
    const settlements = await FoodRestaurantSettlement.find({ cycleKey: w.key }).lean();
    const byRestaurant = new Map();
    for (const s of settlements) byRestaurant.set(String(s.restaurantId), { settlement: s, lines: [] });
    const lockedAnywhere = await lockedOrderIds(bills.map((b) => b.orderId));
    for (const b of bills) {
        const entry = byRestaurant.get(b.restaurantId) || { settlement: null, lines: [] };
        const inHere = entry.settlement?.lines?.some((l) => String(l.orderId) === String(b.orderId));
        if (!inHere && !lockedAnywhere.has(String(b.orderId))) entry.lines.push(b);
        byRestaurant.set(b.restaurantId, entry);
    }
    const names = new Map((await FoodRestaurant.find({ _id: { $in: [...byRestaurant.keys()].map(oid) } }).select('restaurantName').lean())
        .map((r) => [String(r._id), r.restaurantName || '']));
    const rows = [...byRestaurant.entries()].map(([rid, { settlement: s, lines }]) => {
        const t = totalsOf([...(s?.lines || []), ...lines]);
        const balance = round2(t.payable + (s?.carriedIn || 0) - (s?.paid || 0) - (s?.carriedOut || 0));
        return {
            restaurantId: rid,
            restaurantName: names.get(rid) || s?.restaurantName || '',
            settlementNo: s?.settlementNo || '',
            orders: t.orders,
            billTotal: t.billTotal,
            commission: t.commission,
            payable: t.payable,
            carriedIn: round2(s?.carriedIn || 0),
            paid: round2(s?.paid || 0),
            balance,
            status: statusOf(s, balance),
        };
    }).sort((a, b) => b.balance - a.balance || a.restaurantName.localeCompare(b.restaurantName));
    const sum = (k) => round2(rows.reduce((x, r) => x + r[k], 0));
    return {
        cycle: { key: w.key, label: w.label, closed: Date.now() > w.end.getTime() },
        rows,
        totals: { restaurants: rows.length, orders: rows.reduce((x, r) => x + r.orders, 0), billTotal: sum('billTotal'), commission: sum('commission'), payable: sum('payable'), paid: sum('paid'), balance: sum('balance') },
    };
}

/** Earlier settlements of a restaurant, newest first, with their payments. */
export async function settlementHistory({ restaurantId } = {}) {
    if (!isId(restaurantId)) throw new ValidationError('Pick a restaurant');
    const rows = await FoodRestaurantSettlement.find({ restaurantId: oid(restaurantId) })
        .select('settlementNo cycleKey label year month cycle totals carriedIn carriedOut carriedTo paid onHold payments lockedAt')
        .sort({ cycleKey: -1 })
        .lean();
    return rows.map((s) => {
        const balance = balanceOf(s);
        return {
            settlementNo: s.settlementNo,
            label: s.label,
            year: s.year,
            month: s.month,
            cycle: s.cycle,
            orders: s.totals?.orders || 0,
            payable: s.totals?.payable || 0,
            carriedIn: s.carriedIn || 0,
            carriedOut: s.carriedOut || 0,
            carriedTo: s.carriedTo || '',
            paid: s.paid || 0,
            balance,
            status: statusOf(s, balance),
            lockedAt: s.lockedAt,
            payments: (s.payments || []).map(describePayment),
        };
    });
}

/* ------------------------------------------------------------------ */
/* Locking, paying, holding                                            */
/* ------------------------------------------------------------------ */

/**
 * The settlement of this cycle, created on first use: its unlocked bills are
 * locked to it, and earlier unpaid balances (not on hold) are carried into it.
 * Later calls add bills of the period that were delivered after the lock.
 */
async function lockCycle(restaurantId, w, actor) {
    const rid = oid(restaurantId);
    let s = await FoodRestaurantSettlement.findOne({ restaurantId: rid, cycleKey: w.key });
    const live = await billsInWindow(w, restaurantId);
    const have = new Set((s?.lines || []).map((l) => String(l.orderId)));
    const elsewhere = await lockedOrderIds(live.filter((l) => !have.has(String(l.orderId))).map((l) => l.orderId));
    const fresh = live.filter((l) => !have.has(String(l.orderId)) && !elsewhere.has(String(l.orderId)))
        .map(({ restaurantId: _r, ...l }) => l);

    if (!s) {
        const restaurant = await FoodRestaurant.findById(rid).select('restaurantName').lean();
        if (!restaurant) throw new ValidationError('Restaurant not found');
        s = await FoodRestaurantSettlement.create({
            settlementNo: settlementNoOf(w, restaurantId),
            restaurantId: rid,
            restaurantName: restaurant.restaurantName || '',
            cycleKey: w.key,
            year: w.year,
            month: w.month,
            cycle: w.cycle,
            periodStart: w.start,
            periodEnd: w.end,
            label: w.label,
            lines: fresh,
            totals: totalsOf(fresh),
            lockedBy: { id: String(actor?.id || ''), name: String(actor?.name || '') },
        });
        // Carry earlier unpaid balances forward into this one.
        const earlier = (await earlierOpen(restaurantId, w.key)).filter((e) => !e.onHold);
        let carried = 0;
        const from = [];
        for (const e of earlier) {
            const moved = await FoodRestaurantSettlement.findOneAndUpdate(
                { settlementNo: e.settlementNo, carriedTo: '' },
                { $set: { carriedTo: s.settlementNo, carriedOut: e.balance } },
                { new: true },
            );
            if (moved) {
                carried += e.balance;
                from.push(e.settlementNo);
            }
        }
        if (carried > 0) {
            s.carriedIn = round2(carried);
            s.carriedFrom = from;
            await s.save();
        }
        return s;
    }
    if (fresh.length) {
        s.lines.push(...fresh);
        s.totals = totalsOf(s.lines);
        await s.save();
    }
    return s;
}

const MODE_LABEL = { upi: 'UPI', bank_transfer: 'Bank transfer', cash: 'Cash' };

/**
 * Record a payment against a cycle (Clear Payment). Partial payments are
 * allowed; the rest stays pending and carries into the next settlement.
 */
export async function recordPayment(body = {}, actor = null) {
    const { restaurantId } = body;
    if (!isId(restaurantId)) throw new ValidationError('Pick a restaurant');
    const w = cycleWindow(body.year, body.month, body.cycle);
    const amount = round2(body.amount);
    if (!(amount >= 1)) throw new ValidationError('Enter the amount paid (at least ₹1)');
    const mode = PAYMENT_MODES.includes(body.mode) ? body.mode : null;
    if (!mode) throw new ValidationError('Choose UPI, bank transfer or cash');
    const utr = String(body.utr || '').trim();
    if (mode !== 'cash' && utr.length < 4) throw new ValidationError(`Enter the ${mode === 'upi' ? 'UPI transaction ID' : 'UTR'} of the payment`);
    const paidOn = body.paidOn ? new Date(body.paidOn) : new Date();
    if (Number.isNaN(paidOn.getTime())) throw new ValidationError('Payment date is not a date');
    if (paidOn.getTime() > Date.now() + 24 * 3600 * 1000) throw new ValidationError('Payment date is in the future');
    let officer = null;
    if (body.officerId) {
        if (!isId(body.officerId)) throw new ValidationError('Pick the payment officer');
        officer = await FoodAdmin.findById(body.officerId).select('name email').lean();
        if (!officer) throw new ValidationError('Payment officer not found');
    }
    if (!officer) throw new ValidationError('Pick the payment officer');
    const requestId = String(body.requestId || '').trim().slice(0, 80);

    return withFinanceLock(restaurantWithdrawalLockKey(restaurantId), async () => {
        if (requestId) {
            const done = await FoodRestaurantSettlement.findOne({ 'payments.requestId': requestId }).select('settlementNo').lean();
            if (done) return { settlementNo: done.settlementNo, duplicate: true };
        }
        if (utr) {
            const used = await FoodRestaurantSettlement.findOne({ 'payments.utr': utr }).select('settlementNo').lean();
            if (used) throw new ValidationError(`This transaction ID / UTR is already recorded on ${used.settlementNo}. A payment is recorded once.`);
        }
        const existing = await FoodRestaurantSettlement.findOne({ restaurantId: oid(restaurantId), cycleKey: w.key }).select('onHold carriedTo').lean();
        if (existing?.onHold) throw new ValidationError('This settlement is on hold. Release the hold before paying.');
        if (existing?.carriedTo) throw new ValidationError(`The balance of this cycle moved to ${existing.carriedTo}. Pay it there.`);

        // A request the restaurant filed itself is a claim on the same money.
        const pending = await FoodRestaurantWithdrawal.find({ restaurantId: oid(restaurantId), status: 'pending' }).lean();
        const manual = pending.filter((p) => !p.autoCreated);
        if (manual.length) {
            throw new ValidationError(`The restaurant has a withdrawal request of ₹${manual[0].amount} waiting. Approve or reject it in Restaurant withdrawals first, so the same money is not paid twice.`);
        }

        // Checked on the figures the screen showed, before anything is locked, so a
        // refused payment leaves the cycle as it was.
        const preview = await getCycle({ restaurantId, year: w.year, month: w.month, cycle: w.cycle });
        if (preview.balance <= 0.009) throw new ValidationError('Nothing is pending on this settlement');
        if (amount > preview.balance) throw new ValidationError(`₹${amount} is more than the ₹${preview.balance} pending on this settlement`);
        if (amount > preview.wallet.unpaidEarnings + 0.009) {
            throw new ValidationError(`The restaurant's unpaid earnings are ₹${round2(Math.max(0, preview.wallet.unpaidEarnings))}: the rest was already paid through withdrawals. Pay at most that.`);
        }

        const s = await lockCycle(restaurantId, w, actor);
        const balance = balanceOf(s);
        if (amount > balance + 0.009) throw new ValidationError(`₹${amount} is more than the ₹${balance} pending on this settlement`);

        // The automatic cycle request stands for the same earnings; this payment replaces it.
        for (const p of pending.filter((x) => x.autoCreated)) {
            await FoodRestaurantWithdrawal.updateOne(
                { _id: p._id, status: 'pending' },
                { $set: { status: 'rejected', rejectionReason: `Paid through settlement ${s.settlementNo}`, processedAt: new Date() } },
            );
        }

        const withdrawal = await FoodRestaurantWithdrawal.create({
            restaurantId: oid(restaurantId),
            amount,
            status: 'approved',
            paymentMethod: mode,
            transactionId: utr,
            adminNote: `Settlement ${s.settlementNo} (${s.label}) · ${MODE_LABEL[mode]} · by ${officer.name || officer.email || 'admin'}`,
            processedAt: paidOn,
        });
        const updated = await FoodRestaurantSettlement.findOneAndUpdate(
            { _id: s._id, paid: s.paid },
            {
                $push: {
                    payments: {
                        amount,
                        mode,
                        utr,
                        paidOn,
                        officerId: String(officer._id),
                        officerName: officer.name || officer.email || '',
                        note: String(body.note || '').trim().slice(0, 300),
                        withdrawalId: withdrawal._id,
                        requestId,
                        recordedBy: { id: String(actor?.id || ''), name: String(actor?.name || '') },
                    },
                },
                $inc: { paid: amount },
            },
            { new: true },
        ).lean();
        if (!updated) {
            await FoodRestaurantWithdrawal.deleteOne({ _id: withdrawal._id });
            throw new ValidationError('This settlement changed while paying. Refresh and try again.');
        }
        const left = balanceOf(updated);
        return { settlementNo: updated.settlementNo, paid: amount, balance: left, status: statusOf(updated, left) };
    });
}

/** Put a cycle on hold (it is locked if it was not) or release it. */
export async function setHold(body = {}, actor = null) {
    const { restaurantId } = body;
    if (!isId(restaurantId)) throw new ValidationError('Pick a restaurant');
    const w = cycleWindow(body.year, body.month, body.cycle);
    const hold = body.hold === true;
    return withFinanceLock(restaurantWithdrawalLockKey(restaurantId), async () => {
        let s = await FoodRestaurantSettlement.findOne({ restaurantId: oid(restaurantId), cycleKey: w.key });
        if (!s && !hold) throw new ValidationError('This cycle is not on hold');
        if (!s) s = await lockCycle(restaurantId, w, actor);
        if (s.carriedTo) throw new ValidationError(`The balance of this cycle moved to ${s.carriedTo}`);
        s.onHold = hold;
        s.holdNote = hold ? String(body.note || '').trim().slice(0, 300) : '';
        await s.save();
        return { settlementNo: s.settlementNo, onHold: s.onHold };
    });
}
