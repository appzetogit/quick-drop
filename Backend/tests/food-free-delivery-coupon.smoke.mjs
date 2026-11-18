/**
 * A free-delivery coupon for first-time customers (Admin > Coupons, discount
 * type "Free Delivery").
 *
 * Run: node tests/food-free-delivery-coupon.smoke.mjs
 *
 * Drives the real validators and calculateOrderPricing against an in-memory Mongo.
 */
import { startFoodWorld, makeChecker, near, thrownBy } from './food-order-fixture.mjs';

const w = await startFoodWorld('free_delivery_coupon');
const { check, summary } = makeChecker();
let failed = 1;

try {
    const { validateCreateOfferDto } = await import('../src/modules/food/admin/validators/offer.validator.js');
    const items = [w.appLine(w.dish)];
    const riderPay = (q) => Number(q.deliveryFeeBreakdown?.riderDeliveryEarningAfterAdminCommission ?? q.deliveryFeeBreakdown?.riderPay);

    console.log('\ncreating the coupon');
    const dto = validateCreateOfferDto(
        { couponCode: 'firstfree', discountType: 'free-delivery', customerScope: 'first-time', perUserLimit: 1 },
        { allowFreeDelivery: true },
    );
    check('the admin can create it with no amount', dto.discountType === 'free-delivery' && dto.discountValue === 0 && dto.couponCode === 'FIRSTFREE',
        JSON.stringify({ t: dto.discountType, v: dto.discountValue }));
    const refused = await thrownBy(() => validateCreateOfferDto({ couponCode: 'X', discountType: 'free-delivery' }));
    check('a restaurant cannot (the platform pays it)', /only be created by the admin/.test(refused?.message || ''), refused?.message);
    const noAmount = await thrownBy(() => validateCreateOfferDto({ couponCode: 'Y', discountType: 'flat-price', discountValue: 0 }, { allowFreeDelivery: true }));
    check('other coupons still need an amount', /greater than 0/.test(noAmount?.message || ''), noAmount?.message);
    await w.m.FoodOffer.create({ ...dto, status: 'active', createdByRole: 'ADMIN' });

    const buyer = await w.makeUser();
    console.log('\na first-time customer');
    const plain = await w.quote(buyer._id, { items });
    const q = await w.quote(buyer._id, { items, couponCode: 'FIRSTFREE' });
    check('without the coupon delivery is Rs 30', near(plain.deliveryFee, 30), `delivery ${plain.deliveryFee}`);
    check('with it delivery is free', near(q.deliveryFee, 0), `delivery ${q.deliveryFee}`);
    check('the coupon shows as applied', q.appliedCoupon?.code === 'FIRSTFREE' && q.appliedCoupon?.type === 'free-delivery',
        JSON.stringify(q.appliedCoupon));
    check('the food is not discounted', near(q.discount, 0) && near(q.subtotal, plain.subtotal), `discount ${q.discount}`);
    check('the total is exactly Rs 30 less', near(plain.total - q.total, 30), `${plain.total} -> ${q.total}`);
    check('the waiver is recorded as a coupon', q.deliveryFeeBreakdown?.freeDeliveryReason === 'coupon' && near(q.deliveryFeeBreakdown?.waivedDeliveryFee, 30),
        JSON.stringify(q.deliveryFeeBreakdown));
    check('the rider is paid the same', near(riderPay(q), riderPay(plain)), `${riderPay(plain)} -> ${riderPay(q)}`);

    console.log('\nafter a delivered order');
    await w.m.FoodOrder.collection.insertOne({ userId: buyer._id, restaurantId: w.restaurant._id, orderStatus: 'delivered', createdAt: new Date() });
    const again = await w.quote(buyer._id, { items, couponCode: 'FIRSTFREE' });
    check('it no longer applies', !again.appliedCoupon && near(again.deliveryFee, 30), `delivery ${again.deliveryFee}`);
    check('and says why', /only for your first order/.test(again.couponRejectedReason || ''), again.couponRejectedReason);

    console.log('\nwhen delivery is already free');
    const freeDish = await w.makeDish({ name: 'Free Thali', price: 200, freeDelivery: true });
    const other = await w.makeUser();
    const already = await w.quote(other._id, { items: [w.appLine(freeDish)], couponCode: 'FIRSTFREE' });
    check('the coupon is not spent for nothing', !already.appliedCoupon, JSON.stringify(already.appliedCoupon));
    check('and the customer is told', /already free/.test(already.couponRejectedReason || ''), already.couponRejectedReason);

    failed = summary();
} catch (err) {
    console.log(`\n  UNCAUGHT: ${err.stack || err.message}`);
} finally {
    await w.stop();
    process.exit(failed ? 1 : 0);
}
