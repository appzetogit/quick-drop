/**
 * Restaurant settlement per 10-day cycle (food/admin/settlements).
 *
 * Run: node tests/restaurant-settlement.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
await mongoose.connect(replSet.getUri(), { dbName: 'restaurant_settlement' });
const stl = await import('../src/modules/food/admin/settlements/settlement.service.js');
const { FoodRestaurantSettlement } = await import('../src/modules/food/admin/settlements/settlement.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
const { FoodOrder } = await import('../src/modules/food/orders/models/order.model.js');
const { FoodTransaction } = await import('../src/modules/food/orders/models/foodTransaction.model.js');
const { FoodRestaurantWithdrawal } = await import('../src/modules/food/restaurant/models/foodRestaurantWithdrawal.model.js');
const { FoodAdmin } = await import('../src/core/admin/admin.model.js');
await FoodRestaurantSettlement.syncIndexes();
await FoodRestaurantWithdrawal.syncIndexes();

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.stack?.split('\n').slice(0, 3).join(' | ')}`); }
};
const oid = () => new mongoose.Types.ObjectId();
const ist = (y, m, d, h = 12) => new Date(Date.UTC(y, m - 1, d, h) - (5.5 * 3600 * 1000));

const rest = oid();
await FoodRestaurant.collection.insertOne({ _id: rest, restaurantName: 'Sharma Dhaba', status: 'approved', location: { type: 'Point', coordinates: [76.5, 32.1] } });
const officer = (await FoodAdmin.collection.insertOne({ _id: oid(), name: 'Rohit (Accounts)', email: 'acc@example.test', isActive: true })).insertedId;

let n = 0;
/** A delivered order: food 1000 net + 5% GST, packing 50, commission 100. */
async function order(date, { food = 1000, packing = 50, gstToRestaurant = true, status = 'delivered' } = {}) {
    const id = oid();
    const gst = Math.round(food * 5) / 100;
    await FoodOrder.collection.insertOne({
        _id: id, orderId: `FOD-${1000 + (n += 1)}`, restaurantId: rest, userId: oid(), orderStatus: status, createdAt: date,
        pricing: { subtotal: food, commissionableAmount: food, gstRate: 5, tax: gst, packagingFee: packing, netPackagingFee: packing, packagingMode: 'RESTAURANT', restaurantCommission: food / 10, total: food + gst + packing + 30 },
        payment: { method: 'cash' },
    });
    await FoodTransaction.collection.insertOne({
        _id: oid(), orderId: id, restaurantId: rest, userId: oid(), paymentMethod: 'cash', status: 'captured', createdAt: date,
        amounts: { restaurantShare: food + packing - food / 10 + (gstToRestaurant ? gst : 0), restaurantGstPassThrough: gstToRestaurant ? gst : 0, restaurantCommission: food / 10, totalCustomerPaid: 0, riderShare: 0, platformNetProfit: 0 },
    });
    return id;
}

const q = { restaurantId: String(rest), year: 2026, month: 11, cycle: 1 };
await order(ist(2026, 11, 2));
await order(ist(2026, 11, 9));
await order(ist(2026, 11, 10, 23)); // 11 pm on the 10th: still cycle 1
await order(ist(2026, 11, 11, 0)); // after midnight: cycle 2
await order(ist(2026, 11, 5), { status: 'cancelled_by_user' });
await order(ist(2026, 11, 6), { gstToRestaurant: false });

await check('cycles are 1-10, 11-20, 21-end, in India time', async () => {
    assert.equal(stl.cycleWindow(2026, 11, 3).label, '21–30 Nov 2026');
    assert.equal(stl.cycleWindow(2026, 2, 3).label, '21–28 Feb 2026');
    assert.equal(stl.cycleOf(ist(2026, 11, 10, 23)).key, '2026-11-1');
    assert.equal(stl.cycleOf(ist(2026, 11, 11, 0)).key, '2026-11-2');
});

await check('the client example: 1000 + 50 + 50 = 1100, less 100 commission = 1000 payable', async () => {
    const c = await stl.getCycle(q);
    assert.equal(c.lines.length, 4);
    const first = c.lines[0];
    assert.deepEqual([first.basic, first.packing, first.gst, first.billTotal, first.commission, first.deductions, first.payable], [1000, 50, 50, 1100, 100, 0, 1000]);
    assert.equal(c.status, 'pending');
    assert.equal(c.settlement, null);
});

await check('GST kept by the platform shows as a deduction, so the payable is what the ledger pays', async () => {
    const c = await stl.getCycle(q);
    const kept = c.lines.find((l) => l.deductions > 0);
    assert.deepEqual([kept.billTotal, kept.commission, kept.deductions, kept.payable], [1100, 100, 50, 950]);
    assert.deepEqual([c.totals.orders, c.totals.billTotal, c.totals.commission, c.totals.payable], [4, 4400, 400, 3950]);
    assert.equal(c.balance, 3950);
});

await check('a payment needs the officer and a UTR for UPI or bank', async () => {
    await assert.rejects(stl.recordPayment({ ...q, amount: 100, mode: 'upi', utr: '' , officerId: String(officer) }), /UPI transaction ID/);
    await assert.rejects(stl.recordPayment({ ...q, amount: 100, mode: 'cash' }), /payment officer/);
});

let firstNo;
await check('a partial payment locks the cycle bills under one settlement number and pays the wallet', async () => {
    const r = await stl.recordPayment({ ...q, amount: 2000, mode: 'upi', utr: 'UPI123456', officerId: String(officer), requestId: 'click-1' }, { id: 'a', name: 'Om' });
    firstNo = r.settlementNo;
    assert.match(firstNo, /^STL-2611-C1-/);
    assert.deepEqual([r.balance, r.status], [1950, 'partial']);
    const s = await FoodRestaurantSettlement.findOne({ settlementNo: firstNo }).lean();
    assert.equal(s.lines.length, 4);
    const w = await FoodRestaurantWithdrawal.find({ restaurantId: rest }).lean();
    assert.deepEqual(w.map((x) => [x.status, x.amount, x.transactionId]), [['approved', 2000, 'UPI123456']]);
});

await check('the same click twice pays once; the same UTR twice is refused', async () => {
    const again = await stl.recordPayment({ ...q, amount: 2000, mode: 'upi', utr: 'UPI123456', officerId: String(officer), requestId: 'click-1' });
    assert.equal(again.duplicate, true);
    await assert.rejects(stl.recordPayment({ ...q, amount: 10, mode: 'upi', utr: 'UPI123456', officerId: String(officer), requestId: 'click-2' }), /already recorded/);
    assert.equal(await FoodRestaurantWithdrawal.countDocuments({ restaurantId: rest }), 1);
});

await check('more than is pending is refused', async () => {
    await assert.rejects(stl.recordPayment({ ...q, amount: 5000, mode: 'cash', officerId: String(officer) }), /more than the ₹1950 pending/);
});

await check('a restaurant-filed withdrawal waiting blocks payment; an automatic one is replaced', async () => {
    const manual = await FoodRestaurantWithdrawal.create({ restaurantId: rest, amount: 500, status: 'pending' });
    await assert.rejects(stl.recordPayment({ ...q, amount: 100, mode: 'cash', officerId: String(officer) }), /withdrawal request of ₹500 waiting/);
    await FoodRestaurantWithdrawal.deleteOne({ _id: manual._id });
    const auto = await FoodRestaurantWithdrawal.create({ restaurantId: rest, amount: 1950, status: 'pending', autoCreated: true, autoCycleKey: '2026-11-a' });
    await stl.recordPayment({ ...q, amount: 950, mode: 'bank_transfer', utr: 'UTR778899', officerId: String(officer) });
    assert.equal((await FoodRestaurantWithdrawal.findById(auto._id).lean()).status, 'rejected');
});

await check('hold stops payment; the unpaid rest carries into the next cycle when that is paid', async () => {
    await stl.setHold({ ...q, hold: true, note: 'bill query' });
    await assert.rejects(stl.recordPayment({ ...q, amount: 100, mode: 'cash', officerId: String(officer) }), /on hold/);
    await stl.setHold({ ...q, hold: false });
    const c2 = await stl.getCycle({ ...q, cycle: 2 });
    assert.equal(c2.carriedIn, 1000);
    assert.equal(c2.balance, 2000);
    const r = await stl.recordPayment({ ...q, cycle: 2, amount: 2000, mode: 'cash', officerId: String(officer) });
    assert.deepEqual([r.balance, r.status], [0, 'paid']);
    const old = await stl.getCycle(q);
    assert.equal(old.status, 'carried_forward');
    assert.equal(old.settlement.carriedTo, r.settlementNo);
});

await check('a bill is locked once: an order delivered late joins at the next payment, never twice', async () => {
    const late = await order(ist(2026, 11, 20));
    const c2 = await stl.getCycle({ ...q, cycle: 2 });
    assert.equal(c2.unlockedCount, 1);
    assert.equal(c2.balance, 1000);
    await stl.recordPayment({ ...q, cycle: 2, amount: 1000, mode: 'cash', officerId: String(officer) });
    const docs = await FoodRestaurantSettlement.find({ 'lines.orderId': late }).lean();
    assert.equal(docs.length, 1);
});

await check('never more than the restaurant unpaid earnings (money already paid through withdrawals)', async () => {
    await order(ist(2026, 11, 22));
    // Ledger: 8 rows = 7950 earned, 5950 paid here; an older withdrawal of 1900 leaves 100 unpaid.
    await FoodRestaurantWithdrawal.create({ restaurantId: rest, amount: 1900, status: 'approved' });
    await assert.rejects(stl.recordPayment({ ...q, cycle: 3, amount: 1000, mode: 'cash', officerId: String(officer) }), /unpaid earnings are ₹100/);
    assert.equal(await FoodRestaurantSettlement.countDocuments({ cycleKey: '2026-11-3' }), 0);
});

await check('overview and history list the settlements', async () => {
    const o = await stl.cycleOverview({ year: 2026, month: 11, cycle: 1 });
    assert.equal(o.rows.length, 1);
    assert.equal(o.rows[0].status, 'carried_forward');
    const h = await stl.settlementHistory({ restaurantId: String(rest) });
    assert.deepEqual(h.map((s) => s.status), ['paid', 'carried_forward']);
    assert.equal(h[1].payments.length, 2);
});

await mongoose.disconnect();
await replSet.stop();
console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
