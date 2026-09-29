/**
 * Quick & Medical orders reach riders who work through the Food side.
 *
 * Run: node tests/qc-orders-via-food-rider.smoke.mjs
 *
 * The delivery app signs in, goes online and acts only through the Food rider
 * endpoints. These checks: the Food rider gets a linked Quick rider record,
 * going online carries over, Quick dispatch counts them, and accepting a
 * Medical order through the Food accept endpoint assigns it to them.
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const server = await MongoMemoryServer.create();
await mongoose.connect(server.getUri(), { dbName: 'qc_via_food' });

let failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${label}\n        ${e.stack || e.message}`); }
};

const { FoodDeliveryPartner: FoodRider } = await import('../src/modules/food/delivery/models/deliveryPartner.model.js');
const { FoodDeliveryPartner: QcRider } = await import('../src/modules/quickCommerce/modules/food/delivery/models/deliveryPartner.model.js');
const { FoodOrder: QcOrder } = await import('../src/modules/quickCommerce/modules/food/orders/models/order.model.js');
const { FoodOrder } = await import('../src/modules/food/orders/models/order.model.js');
const link = await import('../src/core/delivery/qcRiderLink.js');
const { updateDeliveryAvailability } = await import('../src/modules/food/delivery/services/delivery.service.js');

const food = await FoodRider.create({ name: 'Rishi Dogne', phone: '9876500001', status: 'approved' });
const foodId = String(food._id);

await check('a Food rider gets one linked Quick rider record (created once)', async () => {
  const a = await link.qcRiderIdForFoodRider(foodId);
  const b = await link.qcRiderIdForFoodRider(foodId);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(await QcRider.countDocuments({ phone: { $regex: '9876500001$' } }), 1);
  assert.equal(await link.foodRiderIdForQcRider(a), foodId);
});

await check('going online in the Food app also puts the Quick record online, with position', async () => {
  await updateDeliveryAvailability(foodId, { status: 'online', latitude: 22.7262, longitude: 75.8885 });
  await new Promise((r) => setTimeout(r, 200));
  const qc = await QcRider.findById(await link.qcRiderIdForFoodRider(foodId)).lean();
  assert.equal(qc.availabilityStatus, 'online');
  assert.equal(qc.lastLat, 22.7262);
});

await check('Quick dispatch counts online Food riders as Quick candidates', async () => {
  const c = await link.onlineFoodRidersAsQcCandidates();
  assert.equal(c.length, 1);
  assert.equal(String(c[0]._id), await link.qcRiderIdForFoodRider(foodId));
  assert.equal(c[0].foodRiderId, foodId);
});

const qcRiderId = await link.qcRiderIdForFoodRider(foodId);
const medOrder = await QcOrder.collection.insertOne({
  order_id: 'MED-1000000001', orderId: 'MED-1000000001', orderStatus: 'preparing',
  userId: new mongoose.Types.ObjectId(), restaurantId: new mongoose.Types.ObjectId(),
  items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Paracetamol', price: 25, quantity: 1 }],
  pricing: { subtotal: 25, total: 25 }, payment: { method: 'cash', status: 'cod_pending' },
  prescription: { required: true, status: 'approved', bill: { status: 'approved' } },
  dispatch: { status: 'unassigned', offeredTo: [{ partnerId: new mongoose.Types.ObjectId(qcRiderId), at: new Date(), action: 'offered' }] },
  deliveryAddress: { city: 'Indore', state: 'MP', location: { type: 'Point', coordinates: [75.88, 22.72] } },
  createdAt: new Date(), updatedAt: new Date(),
});
const medId = String(medOrder.insertedId);

await check('a Quick order id is recognised; a Food one is not', async () => {
  assert.equal(await link.isQcOrderId(medId), true);
  assert.equal(await link.isQcOrderId('MED-1000000001'), true);
  const f = await FoodOrder.collection.insertOne({ order_id: 'FOD-1', createdAt: new Date() });
  assert.equal(await link.isQcOrderId(String(f.insertedId)), false);
});

await check('accepting the Medical order through the FOOD accept endpoint assigns it', async () => {
  const ctrl = await import('../src/modules/food/orders/controllers/order.controller.js');
  const out = await new Promise((resolve, reject) => {
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    ctrl.acceptOrderDeliveryController({ params: { orderId: medId }, user: { userId: foodId, role: 'DELIVERY_PARTNER' }, body: {} }, res, reject);
  });
  assert.equal(out.code, 200, JSON.stringify(out.body).slice(0, 300));
  const row = await QcOrder.collection.findOne({ _id: new mongoose.Types.ObjectId(medId) });
  assert.equal(row.dispatch.status, 'accepted');
  assert.equal(String(row.dispatch.deliveryPartnerId), qcRiderId);
});

await mongoose.disconnect();
await server.stop();
console.log(failed ? `\n${failed} FAILED` : '\nall quick-via-food-rider checks passed');
process.exit(failed ? 1 : 0);
