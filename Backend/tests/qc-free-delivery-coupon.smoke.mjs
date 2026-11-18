/**
 * Free-delivery coupons in quick commerce (Admin > Quick Commerce > Coupons,
 * discount type "Free Delivery"), e.g. for first-time customers.
 *
 * Run: node tests/qc-free-delivery-coupon.smoke.mjs
 *
 * Drives the real validator and calculateOrderPricing() on an in-memory Mongo.
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let failed = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  PASS  ${label}`); }
    catch (err) { failed += 1; console.log(`  FAIL  ${label}\n        ${err.message}`); }
};

process.env.MONGOMS_STARTUP_TIMEOUT ||= '180000';
const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'qc_free_delivery_coupon' });

const BASE = '../src/modules/quickCommerce/modules/food';
const { calculateOrderPricing, calculateRiderEarning } = await import(`${BASE}/orders/services/order-pricing.service.js`);
const { validateCreateOfferDto } = await import(`${BASE}/admin/validators/offer.validator.js`);
const { FoodItem } = await import(`${BASE}/admin/models/food.model.js`);
const { FoodFeeSettings } = await import(`${BASE}/admin/models/feeSettings.model.js`);
const { FoodOffer } = await import(`${BASE}/admin/models/offer.model.js`);
const { FoodOrder } = await import(`${BASE}/orders/models/order.model.js`);

const id = () => new mongoose.Types.ObjectId();
const restaurantId = id();
const restaurant = {
    _id: restaurantId, restaurantName: 'Corner Kirana', status: 'approved',
    location: { type: 'Point', coordinates: [77.6, 12.9], latitude: 12.9, longitude: 77.6 },
};
const deliveryAddress = { street: '1 MG Road', city: 'Bengaluru', state: 'KA', location: { type: 'Point', coordinates: [77.61, 12.91] } };
const fees = await FoodFeeSettings.create({
    deliveryFee: 25, deliveryFeeRanges: [], platformFee: 5, gstRate: 5, isActive: true, quickDeliveryFee: 10,
});
const rice = await FoodItem.create({ restaurantId, name: 'Rice 5kg', price: 300, gstRate: 5, approvalStatus: 'approved' });
const items = [{ itemId: String(rice._id), quantity: 1, price: 300 }];
const price = (userId, extra = {}) => calculateOrderPricing(String(userId), {
    restaurantId: String(restaurantId), items, deliveryAddress, ...extra,
}, { restaurant, skipAvailabilityCheck: true });

console.log('\ncreating the coupon');
let dto;
await check('the admin can create it with no amount; the platform bears it all', () => {
    dto = validateCreateOfferDto(
        { couponCode: 'qcfirstfree', discountType: 'free-delivery', customerScope: 'first-time', perUserLimit: 1, adminBearPercentage: 40, restaurantBearPercentage: 60 },
        { allowFreeDelivery: true },
    );
    assert.equal(dto.discountType, 'free-delivery');
    assert.equal(dto.discountValue, 0);
    assert.equal(dto.couponCode, 'QCFIRSTFREE');
    assert.equal(dto.adminBearPercentage, 100);
    assert.equal(dto.restaurantBearPercentage, 0);
});
await check('a store cannot create one', () => {
    assert.throws(() => validateCreateOfferDto({ couponCode: 'X', discountType: 'free-delivery' }), /only be created by the admin/);
});
await check('other coupons still need an amount', () => {
    assert.throws(() => validateCreateOfferDto({ couponCode: 'Y', discountType: 'flat-price', discountValue: 0 }, { allowFreeDelivery: true }), /greater than 0/);
});
await FoodOffer.create({ ...dto, status: 'active', createdByRole: 'ADMIN' });

console.log('\na first-time customer');
const buyer = id();
const plain = (await price(buyer)).pricing;
const withCoupon = (await price(buyer, { couponCode: 'QCFIRSTFREE' })).pricing;
await check('without the coupon delivery is Rs 25 plus its GST', () => {
    assert.equal(plain.deliveryFee, 25);
    assert.ok(plain.deliveryFeeGst > 0, `gst ${plain.deliveryFeeGst}`);
});
await check('with it the delivery fee and its GST are gone', () => {
    assert.equal(withCoupon.deliveryFee, 0);
    assert.equal(withCoupon.deliveryFeeGst, 0);
    assert.equal(withCoupon.waivedDeliveryFee, 25);
});
await check('the coupon is applied, the items are not discounted', () => {
    assert.equal(withCoupon.appliedCoupon?.type, 'free-delivery');
    assert.equal(withCoupon.discount, 0);
    assert.equal(withCoupon.subtotal, plain.subtotal);
    assert.equal(withCoupon.tax, plain.tax);
});
await check('the total drops by the fee and its GST', () => {
    const expected = Math.round(plain.total - 25 - plain.deliveryFeeGst);
    assert.ok(Math.abs(withCoupon.total - expected) <= 1, `${plain.total} -> ${withCoupon.total}, expected ~${expected}`);
});
await check('the waiver is recorded in the breakdown', () => {
    assert.equal(withCoupon.deliveryFeeBreakdown?.freeDeliveryReason, 'coupon');
    assert.equal(withCoupon.deliveryFeeBreakdown?.waivedDeliveryFee, 25);
});
await check('the rider is paid from distance, not the fee', () => {
    const km = withCoupon.distanceKm;
    assert.equal(calculateRiderEarning(fees.toObject(), km), calculateRiderEarning(fees.toObject(), plain.distanceKm));
});
await check('"quick delivery" is still charged', async () => {
    const quick = (await price(buyer, { couponCode: 'QCFIRSTFREE', deliveryMode: 'quick' })).pricing;
    assert.equal(quick.quickDeliveryFee, 10);
    assert.equal(quick.deliveryFee, 0);
});
await check('the order keeps the waiver, so the coupon counts as used', async () => {
    const order = new FoodOrder({ pricing: { subtotal: 300, total: withCoupon.total, couponCode: 'QCFIRSTFREE', couponFreeDelivery: true, waivedDeliveryFee: 25 } });
    assert.equal(order.pricing.couponFreeDelivery, true);
    assert.equal(order.pricing.waivedDeliveryFee, 25);
});

console.log('\nafter a first order');
await FoodOrder.collection.insertOne({ userId: buyer, restaurantId, orderStatus: 'delivered', createdAt: new Date() });
await check('it no longer applies', async () => {
    const again = (await price(buyer, { couponCode: 'QCFIRSTFREE' })).pricing;
    assert.equal(again.appliedCoupon, null);
    assert.equal(again.deliveryFee, 25);
});

console.log('\nwhen delivery is already free');
await FoodFeeSettings.updateOne({ _id: fees._id }, { $set: { deliveryFee: 0 } });
await check('the coupon is not spent for nothing, and says why', async () => {
    const free = (await price(id(), { couponCode: 'QCFIRSTFREE' })).pricing;
    assert.equal(free.appliedCoupon, null);
    assert.match(free.couponRejectedReason || '', /already free/);
});

await mongoose.disconnect();
await mongo.stop();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
