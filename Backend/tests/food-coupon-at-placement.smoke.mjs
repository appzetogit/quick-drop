/**
 * The coupon the cart quoted is the coupon the order charges.
 *
 * Run: node tests/food-coupon-at-placement.smoke.mjs
 *
 * Found in the audit: with a Rs 50 coupon /calculate quoted Rs 199, and the
 * saved order charged Rs 252 with no discount. Placement re-prices from a
 * top-level `couponCode`. The Flutter app and the web send the coupon only
 * inside `pricing`, echoing /calculate, and the create validator's pricing
 * schema did not declare it, so it was stripped and the coupon never reached
 * the re-price. The use was never counted either.
 *
 * Drives the real validators and createOrder against an in-memory Mongo.
 */
import { startFoodWorld, makeChecker, near } from './food-order-fixture.mjs';

const w = await startFoodWorld('coupon_at_placement');
const { check, summary } = makeChecker();
let failed = 1;

try {
    await w.m.FoodOffer.create({ couponCode: 'SAVE50', discountType: 'flat-price', discountValue: 50, status: 'active' });
    const items = [w.appLine(w.dish)];
    const usedCount = async () => (await w.m.FoodOffer.findOne({ couponCode: 'SAVE50' }).lean()).usedCount;

    console.log('\nthe Flutter app: the coupon travels only inside pricing');
    const buyer = await w.makeUser();
    const quoted = await w.quote(buyer._id, { items, couponCode: 'SAVE50' });
    check('the cart is quoted Rs 199 with the coupon', near(quoted.total, 199) && near(quoted.discount, 50),
        `total ${quoted.total}, discount ${quoted.discount}`);

    const order = await w.saved(await w.place(buyer._id, { items, pricing: quoted }));
    check('THE BUG: the order is charged the quoted Rs 199, not Rs 252', near(order.pricing.total, 199),
        `charged ${order.pricing.total}`);
    check('the discount is on the saved order', near(order.pricing.discount, 50), `${order.pricing.discount}`);
    check('the customer is asked for Rs 199', near(order.payment.amountDue, 199), `${order.payment.amountDue}`);
    check('the coupon use is counted', (await usedCount()) === 1, `usedCount ${await usedCount()}`);

    console.log('\nan older web build: pricing.couponCode only');
    const webBuyer = await w.makeUser();
    const webQuote = await w.quote(webBuyer._id, { items, couponCode: 'SAVE50' });
    const webOrder = await w.saved(await w.place(webBuyer._id, { items, pricing: { ...webQuote, couponCode: 'SAVE50' } }));
    check('charged Rs 199', near(webOrder.pricing.total, 199), `charged ${webOrder.pricing.total}`);
    check('counted', (await usedCount()) === 2, `usedCount ${await usedCount()}`);

    console.log('\nno coupon: /calculate echoes couponCode null');
    const plainBuyer = await w.makeUser();
    const plainQuote = await w.quote(plainBuyer._id, { items });
    check('the quote carries couponCode null', plainQuote.couponCode === null, `${plainQuote.couponCode}`);
    const plain = await w.saved(await w.place(plainBuyer._id, { items, pricing: plainQuote }));
    check('the order is still accepted, at Rs 252', near(plain.pricing.total, 252), `charged ${plain.pricing.total}`);

    console.log('\na code the customer is not entitled to is not honoured just for being echoed');
    const sneaky = await w.makeUser();
    const sneakyQuote = await w.quote(sneaky._id, { items });
    const sneakyOrder = await w.saved(await w.place(sneaky._id, { items, pricing: { ...sneakyQuote, couponCode: 'NOSUCHCODE' } }));
    check('an unknown code gives no discount', near(sneakyOrder.pricing.discount, 0) && near(sneakyOrder.pricing.total, 252),
        `discount ${sneakyOrder.pricing.discount}, total ${sneakyOrder.pricing.total}`);

    failed = summary();
} catch (err) {
    console.log(`\n  UNCAUGHT: ${err.stack || err.message}`);
} finally {
    await w.stop();
    process.exit(failed ? 1 : 0);
}
