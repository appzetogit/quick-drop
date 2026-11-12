/**
 * All orders > details: one order in full, whatever service it came from.
 *
 * Run: node tests/master-order-detail.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'master_order_detail' });
const db = mongoose.connection.db;
let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();
const { getMasterOrderDetail } = await import('../src/core/orders/masterOrders.service.js');

const user = oid(); const store = oid(); const rider = oid(); const order = oid(); const qcOrder = oid(); const ride = oid(); const driver = oid();
await db.collection('users').insertOne({ _id: user, name: 'Dev', phone: '9000000001' });
await db.collection('food_restaurants').insertOne({ _id: store, restaurantName: 'TAJ' });
await db.collection('food_delivery_partners').insertOne({ _id: rider, name: 'jk', phone: '9000000002' });
await db.collection('food_orders').insertOne({
    _id: order, order_id: 'FOD-1', userId: user, restaurantId: store, orderStatus: 'delivered',
    items: [{ name: 'Paneer', quantity: 1, price: 530, variantName: 'Full' }],
    pricing: { subtotal: 530, packagingFee: 5, deliveryFee: 0, platformFee: 10, platformFeeGst: 1.8, tax: 26.5, total: 573, deliveryFeeBreakdown: { waivedDeliveryFee: 25 } },
    dispatch: { status: 'accepted', deliveryPartnerId: rider },
});
await db.collection('qc_users').insertOne({ _id: user, name: 'Dev QC' });
await db.collection('qc_orders').insertOne({ _id: qcOrder, userId: user, orderStatus: 'preparing', pricing: { subtotal: 100, deliveryFeeGst: 4.5, total: 130 } });
await db.collection('taxidrivers').insertOne({ _id: driver, name: 'Sachin', phone: '9000000003', vehicleNumber: 'HP01' });
await db.collection('taxirides').insertOne({
    _id: ride, userId: user, driverId: driver, status: 'completed', liveStatus: 'completed', fare: 66, paymentMethod: 'cash',
    pickupAddress: 'Palampur bus stand', dropAddress: 'Holta', estimatedDistanceMeters: 3640, driverEarnings: 56,
    pricingSnapshot: { fare_before_surge: 66, platform_charges_amount: 10, service_tax_amount: 2.82, platform_fee_amount: 5.64, platform_fee_gst_amount: 1.02 },
});

await check('a food order comes with its customer, store, rider and full pricing', async () => {
    const d = await getMasterOrderDetail({ source: 'food', id: String(order) });
    assert.equal(d.kind, 'order');
    assert.equal(d.vertical, 'food');
    assert.deepEqual([d.order.userId.name, d.order.restaurantId.restaurantName, d.order.dispatch.deliveryPartnerId.name], ['Dev', 'TAJ', 'jk']);
    assert.equal(d.order.pricing.packagingFee, 5);
    assert.equal(d.order.items[0].variantName, 'Full');
});
await check('a quick order reads the quick collections', async () => {
    const d = await getMasterOrderDetail({ source: 'quick', id: String(qcOrder) });
    assert.deepEqual([d.vertical, d.order.userId.name, d.order.pricing.deliveryFeeGst], ['quickCommerce', 'Dev QC', 4.5]);
});
await check('a ride comes with the trip bill Trips shows', async () => {
    const d = await getMasterOrderDetail({ source: 'taxi', id: String(ride) });
    assert.equal(d.kind, 'ride');
    assert.deepEqual([d.ride.customer.name, d.ride.driver.name, d.ride.distanceKm], ['Dev', 'Sachin', 3.6]);
    assert.equal(d.bill.customerPays, 66);
    assert.equal(d.bill.lines.tripFare, 56);
});
await check('unknown ids and sources are refused or not found', async () => {
    assert.equal(await getMasterOrderDetail({ source: 'food', id: String(oid()) }), null);
    await assert.rejects(() => getMasterOrderDetail({ source: 'food', id: 'nope' }), /Invalid/);
    await assert.rejects(() => getMasterOrderDetail({ source: 'pizza', id: String(oid()) }), /Unknown/);
});

await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
