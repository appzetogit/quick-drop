/**
 * What GST is charged on when a coupon is involved.
 *
 * Run: node tests/gst-on-funded-discount.smoke.mjs
 *
 * The two cases are not interchangeable, and getting either one wrong costs
 * real money in opposite directions:
 *
 *   RESTAURANT-funded -- a supplier discount given at the time of supply and
 *   shown on the invoice. It comes out of the taxable value. Taxing the full
 *   price here OVERCHARGES the customer.
 *
 *   PLATFORM-funded -- the restaurant is paid in full, part by the customer and
 *   part by the platform, so the supply is still worth the whole amount and the
 *   tax is due on it. Taxing only what the customer paid UNDER-COLLECTS GST.
 *
 * Which one applies is decided by who actually wears the coupon in
 * foodTransaction.service.js: `createdByRole === 'RESTAURANT'` comes off the
 * restaurant's payout, anything else off the platform's profit.
 *
 * The change is forward only: a bill computed without the flag behaves exactly
 * as it did before, which is what the last check pins.
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

check('a restaurant-funded coupon is taxed on what the customer pays', () => {
  const b = computeBill({ ...base, discountFundedByPlatform: false });
  assert.equal(b.taxableAmount, 400);
  assert.equal(b.gstOnItems, 20);
  assert.equal(b.gstOnPreDiscountValue, false);
  assert.ok(billAddsUp(b));
});

check('a platform-funded coupon is taxed on the full value of the supply', () => {
  const b = computeBill({ ...base, discountFundedByPlatform: true });
  assert.equal(b.taxableAmount, 500, 'the restaurant was paid in full');
  assert.equal(b.gstOnItems, 25);
  assert.equal(b.gstOnPreDiscountValue, true);
  // The customer still pays the discounted price for the food.
  assert.equal(b.netItemAmount, 400);
  assert.ok(billAddsUp(b));
});

check('the customer pays the coupon off the food, not off the tax', () => {
  const restaurant = computeBill({ ...base, discountFundedByPlatform: false });
  const platform = computeBill({ ...base, discountFundedByPlatform: true });
  // Rs 5 is exactly the GST on the Rs 100 the platform put in.
  assert.equal(platform.grandTotal - restaurant.grandTotal, 5);
  assert.equal(platform.netItemAmount, restaurant.netItemAmount);
});

check('with no coupon the funder makes no difference', () => {
  const a = computeBill({ ...base, discount: 0, discountFundedByPlatform: true });
  const b = computeBill({ ...base, discount: 0, discountFundedByPlatform: false });
  assert.equal(a.grandTotal, b.grandTotal);
  assert.equal(a.gstOnItems, b.gstOnItems);
  assert.equal(a.gstOnPreDiscountValue, false, 'nothing was funded, so nothing is pre-discount');
});

check('it works the same on a menu priced inclusive of GST', () => {
  const incl = { ...base, pricesIncludeGst: true };
  const r = computeBill({ ...incl, discountFundedByPlatform: false });
  const p = computeBill({ ...incl, discountFundedByPlatform: true });
  // Inclusive: the tax is extracted from inside the price rather than added.
  assert.ok(p.gstOnItems > r.gstOnItems, 'the platform-funded case taxes the larger value');
  assert.equal(r.taxableAmount, r.netItemAmount);
  assert.ok(Math.abs(p.taxableAmount - (500 / 1.05)) < 0.01, 'pre-coupon value, net of the tax inside it');
  assert.ok(billAddsUp(r));
  assert.ok(billAddsUp(p));
});

check('a coupon larger than the food does not invent tax', () => {
  const b = computeBill({ ...base, discount: 900, discountFundedByPlatform: true });
  // The coupon is capped at what the food is worth; tax is still on the supply.
  assert.equal(b.netItemAmount, 0);
  assert.equal(b.taxableAmount, 500);
  assert.ok(billAddsUp(b));
});

check('delivery, surge and tip are never taxed either way', () => {
  const withExtras = { ...base, deliveryFee: 40, surgeAmount: 15, tip: 30 };
  const p = computeBill({ ...withExtras, discountFundedByPlatform: true });
  const r = computeBill({ ...withExtras, discountFundedByPlatform: false });
  // Only the Rs 5 of extra food GST separates them -- nothing else moved.
  assert.equal(round(p.grandTotal - r.grandTotal), 5);
  assert.ok(billAddsUp(p));
});

check('a caller that says nothing gets exactly the old behaviour', () => {
  const before = computeBill({ ...base });
  const explicit = computeBill({ ...base, discountFundedByPlatform: false });
  assert.deepEqual(before, explicit);
  assert.equal(before.taxableAmount, 400);
  // Anything other than a literal true is treated as not funded.
  for (const v of [undefined, null, 0, '', 'true', 1]) {
    assert.equal(computeBill({ ...base, discountFundedByPlatform: v }).gstOnItems, 20, String(v));
  }
});

function round(n) { return Math.round(n * 100) / 100; }

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
