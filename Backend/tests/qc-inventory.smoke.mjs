/**
 * Grocery and fruits & vegetables inventory (quickCommerce/.../inventory).
 *
 * Run: node tests/qc-inventory.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.MONGOMS_STARTUP_TIMEOUT ||= '180000';
const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(replSet.getUri(), { dbName: 'qc_inventory' });

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.stack?.split('\n').slice(0, 2).join(' | ') || err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();

const { FoodItem } = await import('../src/modules/quickCommerce/modules/food/admin/models/food.model.js');
const { FoodRestaurant } = await import('../src/modules/quickCommerce/modules/food/restaurant/models/restaurant.model.js');
const { QCStockMovement } = await import('../src/modules/quickCommerce/modules/food/admin/models/stockMovement.model.js');
const stockLogic = await import('../src/modules/quickCommerce/modules/food/orders/services/inventory.service.js');
const inv = await import('../src/modules/quickCommerce/modules/food/inventory/inventory.service.js');

const store = oid();
await FoodRestaurant.collection.insertOne({ _id: store, restaurantName: 'Rana Supermart', status: 'approved', storeType: 'grocery', location: { type: 'Point', coordinates: [76.53, 32.1] } });

const tomato = oid(); const v500 = oid(); const v1k = oid();
await FoodItem.collection.insertOne({
    _id: tomato, restaurantId: store, name: 'Tomato', price: 40, section: 'fresh', unit: 'kg', stockQty: 10, lowStockThreshold: 3,
    variantsEnabled: true, variants: [{ _id: v500, name: '500 g', price: 20, stockQty: null }, { _id: v1k, name: '1 kg', price: 40, stockQty: null }],
    isAvailable: true, approvalStatus: 'approved', categoryName: 'Vegetables',
});
const atta = oid(); const atta5 = oid(); const atta10 = oid();
await FoodItem.collection.insertOne({
    _id: atta, restaurantId: store, name: 'Aashirvaad Atta', price: 255, mrp: 275, gstRate: 0, section: 'grocery', stockQty: null,
    variantsEnabled: true, variants: [{ _id: atta5, name: '5 kg', price: 255, stockQty: 2, lowStockThreshold: 5 }, { _id: atta10, name: '10 kg', price: 495, stockQty: 0 }],
    isAvailable: true, approvalStatus: 'approved', categoryName: 'Atta & Flour',
});
const row = (id) => FoodItem.collection.findOne({ _id: id });

await check('sizes read their weight from the name, in the product unit', async () => {
    assert.equal(stockLogic.parseUnitsInName('500 g', 'kg'), 0.5);
    assert.equal(stockLogic.parseUnitsInName('250gm pack', 'kg'), 0.25);
    assert.equal(stockLogic.parseUnitsInName('1.5 kg', 'kg'), 1.5);
    assert.equal(stockLogic.parseUnitsInName('500 ml', 'L'), 0.5);
    assert.equal(stockLogic.parseUnitsInName('Dozen', 'kg'), null);
    assert.equal(stockLogic.parseUnitsInName('500 g', 'piece'), null);
});
await check('two 500 g packs take 1 kg from the kg stock, and a cancel gives it back', async () => {
    const taken = await stockLogic.reserveStockForItems([{ itemId: String(tomato), variantId: String(v500), quantity: 2 }], { orderId: oid() });
    assert.equal((await row(tomato)).stockQty, 9);
    const sale = await QCStockMovement.findOne({ itemId: tomato, reason: 'sale' }).lean();
    assert.deepEqual([sale.delta, sale.unitPrice], [-1, 40]);
    await stockLogic.incrementStock(String(tomato), 2, String(v500), { reason: 'cancel' });
    assert.equal((await row(tomato)).stockQty, 10);
    assert.equal(taken.length, 1);
});
await check('a sale larger than the stock is refused', async () => {
    await assert.rejects(() => stockLogic.reserveStockForItems([{ itemId: String(tomato), variantId: String(v1k), quantity: 11 }], { orderId: oid() }), /left|out of stock/);
    assert.equal((await row(tomato)).stockQty, 10);
});

let supplierId;
await check('a supplier is added and listed', async () => {
    const s = await inv.saveSupplier({ name: 'Sharma Traders', phone: '9816000000', supplies: 'Atta, rice' });
    supplierId = String(s._id);
    assert.equal((await inv.listSuppliers()).length, 1);
    await assert.rejects(() => inv.saveSupplier({ name: '  ' }), /name/);
});
await check('a vendor bill fills stock and sets the purchase price; GST on top', async () => {
    const r = await inv.createPurchase({
        restaurantId: String(store), supplierId, billNo: 'ST/0457', billDate: new Date(), paidVia: 'credit',
        lines: [
            { itemId: String(atta), variantId: String(atta5), qty: 40, rate: 228, gstRate: 5 },
            { itemId: String(tomato), qty: 12.5, rate: 24, gstRate: 0 },
        ],
    }, { id: 'a1', name: 'Priya' });
    assert.equal(r.lines, 2);
    assert.equal(r.total, 9120 + 456 + 300);
    const a = await row(atta);
    assert.equal(a.variants.find((v) => String(v._id) === String(atta5)).stockQty, 42);
    assert.equal(a.variants.find((v) => String(v._id) === String(atta5)).purchasePrice, 228);
    const t = await row(tomato);
    assert.deepEqual([t.stockQty, t.purchasePrice], [22.5, 24]);
    const sup = (await inv.listSuppliers())[0];
    assert.equal(sup.onCredit, 9876);
});
await check('a bad line refuses the whole bill and changes nothing', async () => {
    await assert.rejects(() => inv.createPurchase({ restaurantId: String(store), lines: [
        { itemId: String(atta), variantId: String(atta5), qty: 5, rate: 228 },
        { itemId: String(oid()), qty: 1, rate: 1 },
    ] }), /not found/);
    assert.equal((await row(atta)).variants.find((v) => String(v._id) === String(atta5)).stockQty, 42);
});
await check('wastage comes off stock with its reason and its cost', async () => {
    await inv.recordWastage({ itemId: String(tomato), qty: 1.5, reason: 'spoiled', note: 'soft' }, { name: 'Priya' });
    assert.equal((await row(tomato)).stockQty, 21);
    const w = await QCStockMovement.findOne({ itemId: tomato, reason: 'wastage' }).lean();
    assert.deepEqual([w.delta, w.unitCost, w.wasteReason], [-1.5, 24, 'spoiled']);
    await assert.rejects(() => inv.recordWastage({ itemId: String(tomato), qty: 0 }), /how much/);
});
await check('the morning sheet: today\'s moves add up, and a new kg price re-prices the sizes', async () => {
    const sheet = await inv.freshSheet({ restaurantId: String(store) });
    const t = sheet.rows.find((r) => r.itemId === String(tomato));
    assert.deepEqual([t.opening, t.bought, t.sold, t.wasted, t.remaining], [10, 12.5, 0, 1.5, 21]);
    const r = await inv.saveFreshSheet({ rows: [{ itemId: String(tomato), price: 38, bought: 2, boughtRate: 25 }] }, { name: 'Priya' });
    assert.equal(r.saved, 1);
    const after = await row(tomato);
    assert.deepEqual([after.price, after.previousPrice, after.stockQty, after.purchasePrice], [38, 40, 23, 25]);
    assert.deepEqual(after.variants.map((v) => v.price), [19, 38]);
});
await check('unticking Selling hides a product, ticking brings it back', async () => {
    await inv.saveFreshSheet({ rows: [{ itemId: String(tomato), selling: false }] });
    assert.equal((await row(tomato)).isAvailable, false);
    await inv.saveFreshSheet({ rows: [{ itemId: String(tomato), selling: true }] });
    assert.equal((await row(tomato)).isAvailable, true);
});
await check('bulk price change; above the MRP is refused for that row only', async () => {
    const r = await inv.bulkUpdatePrices({ field: 'price', mode: 'pct_up', value: 5, rows: [
        { itemId: String(atta), variantId: String(atta5) },
        { itemId: String(atta), variantId: String(atta10) },
    ] });
    assert.equal(r.updated, 1);
    assert.equal(r.failed, 1);
    assert.match(r.results[1].error, /MRP/);
    const a = await row(atta);
    assert.equal(a.variants.find((v) => String(v._id) === String(atta5)).price, 268);
});
await check('duplicate: same details, no stock, not on sale', async () => {
    const d = await inv.duplicateProduct(String(atta));
    const copy = await row(new mongoose.Types.ObjectId(d.id));
    assert.equal(copy.name, 'Aashirvaad Atta (copy)');
    assert.equal(copy.isAvailable, false);
    assert.ok(copy.variants.every((v) => v.stockQty === null));
    assert.equal(copy.variants.length, 2);
});
await check('dashboard and report read the same entries', async () => {
    const s = await inv.inventorySummary({ restaurantId: String(store), section: 'fresh' });
    assert.equal(s.purchasesToday, 300 + 50); // the bill's tomato line, and 2 kg at Rs 25 on the sheet
    assert.equal(s.wastageToday, 36);
    assert.ok(s.stockValue > 0);
    const g = await inv.inventorySummary({ restaurantId: String(store), section: 'grocery' });
    assert.equal(g.purchasesToday, 9576);
    const rep = await inv.inventoryReport({ restaurantId: String(store), section: 'fresh', days: 7 });
    assert.equal(rep.days.length, 7);
    assert.equal(rep.totals.purchases, 350);
    assert.equal(rep.totals.wastage, 36);
    assert.equal(rep.wastage[0].reason, 'spoiled');
    assert.ok(rep.valuation.rows.length >= 1);
});

await new Promise((r) => setTimeout(r, 300));
await mongoose.disconnect();
await replSet.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
