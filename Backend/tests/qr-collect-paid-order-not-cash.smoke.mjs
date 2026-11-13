/**
 * A paid order stays off the rider's cash limit.
 *
 * An online payment marks only the order paid; its transaction stays at 'created'.
 * The collect QR read the transaction alone, so a rider could open a QR on an order
 * the customer had paid at checkout, and "collect cash" then made it a cash order,
 * counted against the rider's limit.
 *
 * Run: node tests/qr-collect-paid-order-not-cash.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'qr_collect_paid_order' });

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();

const { FoodDeliveryPartner } = await import('../src/modules/food/delivery/models/deliveryPartner.model.js');
const { getRiderFinance } = await import('../src/core/finance/riderFinance.service.js');

const point = { type: 'Point', coordinates: [76.5, 32.1] };
const riderCash = async (rider) => (await getRiderFinance(String(rider))).cashInHand;

for (const [label, root] of [['food', '../src/modules/food'], ['quick commerce', '../src/modules/quickCommerce/modules/food']]) {
    const { FoodOrder } = await import(`${root}/orders/models/order.model.js`);
    const { FoodTransaction } = await import(`${root}/orders/models/foodTransaction.model.js`);
    const { createCollectQr, switchToCash } = await import(`${root}/orders/services/order-payment.service.js`);

    const rider = oid();
    await FoodDeliveryPartner.collection.insertOne({ _id: rider, name: 'Rider', phone: String(Math.random()).slice(2, 12), status: 'approved' });

    const place = async (orderId, payment, txPayment) => {
        const _id = oid();
        await FoodOrder.collection.insertOne({
            _id, orderId, order_id: orderId, userId: oid(), restaurantId: oid(), orderStatus: 'delivered',
            pricing: { total: 500 }, payment, items: [], deliveryAddress: { location: point },
            dispatch: { deliveryPartnerId: rider },
        });
        await FoodTransaction.collection.insertOne({ _id: oid(), orderId: _id, status: 'captured', payment: txPayment, pricing: { total: 500 } });
        return _id;
    };

    // What an online checkout leaves behind: the order paid, the transaction not.
    const onlineId = await place(`${label}-ONLINE`,
        { method: 'razorpay', status: 'paid', amountDue: 500, razorpay: { paymentId: 'pay_1' } },
        { method: 'razorpay', status: 'created', amountDue: 500 });

    await check(`${label}: a QR on an order paid online answers "paid" and opens nothing`, async () => {
        const res = await createCollectQr(String(onlineId), String(rider));
        assert.equal(res.status, 'paid');
        const [o, t] = await Promise.all([
            FoodOrder.collection.findOne({ _id: onlineId }),
            FoodTransaction.collection.findOne({ orderId: onlineId }),
        ]);
        assert.deepEqual([o.payment.method, o.payment.status, t.payment.method], ['razorpay', 'paid', 'razorpay']);
    });
    await check(`${label}: the rider's app gets something it reads as paid, not "no QR came back"`, async () => {
        const res = await createCollectQr(String(onlineId), String(rider));
        assert.ok(res.upiString || res.shortUrl);
    });
    await check(`${label}: it cannot be switched to cash`, async () => {
        await assert.rejects(() => switchToCash(String(onlineId), String(rider)));
        assert.equal((await FoodOrder.collection.findOne({ _id: onlineId })).payment.method, 'razorpay');
    });
    await check(`${label}: an order paid online adds nothing to the rider's cash`, async () => {
        assert.equal(await riderCash(rider), 0);
    });

    await place(`${label}-QR`, { method: 'razorpay_qr', status: 'paid', amountDue: 500 }, { method: 'razorpay_qr', status: 'paid', amountDue: 500 });
    await check(`${label}: an order paid on the rider's QR adds nothing either`, async () => {
        assert.equal(await riderCash(rider), 0);
    });

    await place(`${label}-CASH`, { method: 'cash', status: 'cod_pending', amountDue: 500 }, { method: 'cash', status: 'cod_pending', amountDue: 500 });
    await check(`${label}: real cash still counts`, async () => {
        assert.equal(await riderCash(rider), 500);
    });
}

await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
