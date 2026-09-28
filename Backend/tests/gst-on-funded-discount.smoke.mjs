/**
 * What GST is charged on when a coupon is involved.
 *
 * Run: node tests/gst-on-funded-discount.smoke.mjs
 *
 * GST is charged on what the customer pays for the food after the coupon,
 * whoever funded the coupon. (Until 2026-09-28 a platform-funded coupon was
 * taxed on the pre-coupon value; the GST line then did not move when a coupon
 * was applied, which was reported as a wrong bill.)
 */
import assert from 'node:assert/strict';
import { computeBill, billAddsUp } from '../src/modules/food/shared/billing.js';

let failed = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${label}\n        ${err.message}`); }
};

// Rs 500 of food, a Rs 100 coupon, 5% GST, nothing else on the bill.
const base = {
  itemAmount: 500,
  discount: 100,
  gstRate: 5,
  deliveryFee: 0,
  platformFee: 0,
  platformFeeGstRate: 0,
  packagingFee: 0,
  tip: 0,
};

for (const funded of [false, true]) {
  const who = funded ? 'platform' : 'restaurant';
  check(`a ${who}-funded coupon is taxed on what the customer pays`, () => {
    const b = computeBill({ ...base, discountFundedByPlatform: funded });
    assert.equal(b.taxableAmount, 400);
    assert.equal(b.gstOnItems, 20);
    assert.equal(b.gstOnPreDiscountValue, false);
    assert.equal(b.grandTotal, 420);
    assert.ok(billAddsUp(b));
  });
}

check('the GST goes down when a coupon is applied', () => {
  const without = computeBill({ ...base, discount: 0, discountFundedByPlatform: true });
  const withCoupon = computeBill({ ...base, discountFundedByPlatform: true });
  assert.equal(without.gstOnItems, 25);
  assert.equal(withCoupon.gstOnItems, 20);
});

check('inclusive menu: a Rs 100 coupon on Rs 500 means the customer pays Rs 400, tax extracted from it', () => {
  const b = computeBill({ ...base, pricesIncludeGst: true, discountFundedByPlatform: true });
  assert.equal(b.grandTotal, 400);
  assert.ok(Math.abs(b.gstOnItems - (400 - 400 / 1.05)) < 0.02);
  assert.ok(billAddsUp(b));
});

check('a coupon larger than the food leaves no food tax', () => {
  const b = computeBill({ ...base, discount: 900, discountFundedByPlatform: true });
  assert.equal(b.netItemAmount, 0);
  assert.equal(b.gstOnItems, 0);
  assert.ok(billAddsUp(b));
});

check('delivery, surge and tip are never taxed', () => {
  const b = computeBill({ ...base, deliveryFee: 40, surgeAmount: 15, tip: 30, discountFundedByPlatform: true });
  assert.equal(b.gstOnItems, 20);
  assert.equal(b.grandTotal, 400 + 20 + 40 + 15 + 30);
  // The surge is printed inside the delivery fee, not as its own line.
  assert.equal(b.deliveryFee, 55);
  assert.equal(b.surgeAmount, 0);
  assert.equal(b.surgeIncludedInDeliveryFee, 15);
  assert.ok(billAddsUp(b));
});

check('free delivery keeps the surge on its own line so it is not hidden behind FREE', () => {
  const b = computeBill({ ...base, deliveryFee: 0, surgeAmount: 15, discountFundedByPlatform: true });
  assert.equal(b.deliveryFee, 0);
  assert.equal(b.surgeAmount, 15);
  assert.equal(b.grandTotal, 400 + 20 + 15);
  assert.ok(billAddsUp(b));
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
