/**
 * Inventory stage 2: product import from a sheet (and Quick add), and vendor
 * prices that already include GST.
 *
 * Run: node tests/qc-inventory-import.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.MONGOMS_STARTUP_TIMEOUT ||= '180000';
const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(replSet.getUri(), { dbName: 'qc_inventory_import' });

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.stack?.split('\n').slice(0, 3).join(' | ') || err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();

const { FoodItem } = await import('../src/modules/quickCommerce/modules/food/admin/models/food.model.js');
const { FoodCategory } = await import('../src/modules/quickCommerce/modules/food/admin/models/category.model.js');
const { FoodRestaurant } = await import('../src/modules/quickCommerce/modules/food/restaurant/models/restaurant.model.js');
const { QCStockMovement } = await import('../src/modules/quickCommerce/modules/food/admin/models/stockMovement.model.js');
const { importProducts } = await import('../src/modules/quickCommerce/modules/food/inventory/inventory.import.js');
const inv = await import('../src/modules/quickCommerce/modules/food/inventory/inventory.service.js');

const store = oid();
await FoodRestaurant.collection.insertOne({ _id: store, restaurantName: 'Rana Supermart', status: 'approved', storeType: 'grocery', location: { type: 'Point', coordinates: [76.53, 32.1] } });
const dal = await FoodCategory.create({ name: 'Dal & Pulses', isActive: true, approvalStatus: 'approved' });
await FoodCategory.create({ name: 'Vegetables', isActive: true, approvalStatus: 'approved' });

const sugar = oid();
await FoodItem.collection.insertOne({
    _id: sugar, restaurantId: store, name: 'Sugar', sku: 'SUG1', price: 48, mrp: 50, section: 'grocery', stockQty: 5,
    isAvailable: true, approvalStatus: 'approved', categoryName: 'Dal & Pulses', categoryId: dal._id, variants: [],
});

const sheet = [
    { name: 'Toor Dal', size: '500 g', category: 'dal & pulses', price: '85', mrp: '90', purchasePrice: '70', gstRate: '5', stock: '20', sku: 'TD500' },
    { name: 'Toor Dal', size: '1 kg', category: 'Dal & Pulses', price: '165', mrp: '175', purchasePrice: '136', gstRate: '5', stock: '10' },
    { name: 'Onion', category: 'Vegetables', section: 'Fruits & Vegetables', unit: 'Kg', price: '30', purchasePrice: '22', stock: '12.5' },
    { sku: 'SUG1', name: 'Sugar', price: '46', purchasePrice: '42', purchaseIncludesGst: 'yes', purchaseGstRate: '5', stock: '8' },
    { name: 'Mystery', category: 'Nope', price: '10' },
    { name: 'Cheap Rice', category: 'Dal & Pulses', price: '60', mrp: '50' },
    { name: '' },
];

await check('the dry run reports each row and changes nothing', async () => {
    const r = await importProducts({ restaurantId: String(store), rows: sheet });
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.summary, { create: 3, update: 1, same: 0, error: 3 });
    assert.match(r.rows[4].error, /Category "Nope" not found/);
    assert.match(r.rows[5].error, /above the MRP/);
    assert.match(r.rows[6].error, /name is empty/);
    assert.equal(await FoodItem.countDocuments({ restaurantId: store }), 1);
    assert.equal((await FoodItem.findById(sugar).lean()).price, 48);
});

await check('applying creates a product with sizes, a loose kg item, and updates by SKU', async () => {
    const r = await importProducts({ restaurantId: String(store), rows: sheet, dryRun: false }, { role: 'admin', id: 'a1', name: 'Om' });
    assert.equal(r.summary.create, 3);
    assert.equal(r.summary.update, 1);
    const dalDoc = await FoodItem.findOne({ restaurantId: store, name: 'Toor Dal' }).lean();
    assert.deepEqual(dalDoc.variants.map((v) => [v.name, v.price, v.purchasePrice, v.stockQty]), [['500 g', 85, 70, 20], ['1 kg', 165, 136, 10]]);
    assert.equal(dalDoc.variants[0].sku, 'TD500');
    assert.equal(String(dalDoc.categoryId), String(dal._id));
    assert.equal(dalDoc.mrp ?? null, null);
    assert.deepEqual(dalDoc.variants.map((v) => v.otherPrice), [90, 175]);
    const onion = await FoodItem.findOne({ restaurantId: store, name: 'Onion' }).lean();
    assert.deepEqual([onion.section, onion.unit, onion.stockQty, onion.purchasePrice, onion.price], ['fresh', 'kg', 12.5, 22, 30]);
    const s = await FoodItem.findById(sugar).lean();
    assert.deepEqual([s.price, s.previousPrice, s.purchasePrice, s.purchaseGstRate, s.stockQty], [46, 48, 40, 5, 8]);
    const moves = await QCStockMovement.find({ reason: 'import' }).lean();
    assert.equal(moves.length, 4);
});

await check('running the same sheet again changes nothing', async () => {
    const r = await importProducts({ restaurantId: String(store), rows: sheet.slice(0, 4) });
    assert.deepEqual(r.summary, { create: 0, update: 0, same: 4, error: 0 });
});

await check('a sized product needs the size, and an unknown size is refused', async () => {
    const r = await importProducts({ restaurantId: String(store), rows: [{ name: 'Toor Dal', price: '80' }, { name: 'toor dal', size: '2 kg', price: '300' }] });
    assert.match(r.rows[0].error, /sold by sizes/);
    assert.match(r.rows[1].error, /no size "2 kg"/);
});

await check('quick add is a one-row import', async () => {
    const r = await importProducts({ restaurantId: String(store), rows: [{ name: 'Moong Dal', category: 'Dal & Pulses', price: '120', stock: '6' }], dryRun: false });
    assert.equal(r.summary.create, 1);
    assert.equal((await FoodItem.findOne({ name: 'Moong Dal' }).lean()).stockQty, 6);
});

await check('a vendor price with GST in it: rate kept before GST, bill total as billed', async () => {
    const onion = await FoodItem.findOne({ name: 'Onion' }).lean();
    const dalDoc = await FoodItem.findOne({ name: 'Toor Dal' }).lean();
    const p = await inv.createPurchase({
        restaurantId: String(store), billNo: 'B-77', ratesIncludeGst: true,
        lines: [
            { itemId: String(dalDoc._id), variantId: String(dalDoc.variants[0]._id), qty: 10, rate: 73.5, gstRate: 5 },
            { itemId: String(onion._id), qty: 5, rate: 20, gstRate: 0, rateIncludesGst: false },
        ],
    });
    assert.equal(p.total, 835);
    const after = await FoodItem.findById(dalDoc._id).lean();
    assert.equal(after.variants[0].purchasePrice, 70);
    assert.equal(after.variants[0].stockQty, 30);
});

await mongoose.disconnect();
await replSet.stop();
console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
