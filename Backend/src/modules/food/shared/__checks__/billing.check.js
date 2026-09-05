/**
 * Checks for the customer bill.
 *
 * Run: node Backend/src/modules/food/shared/__checks__/billing.check.js
 */
import assert from 'node:assert/strict';
import { computeBill, billAddsUp, normalizeTip, MAX_TIP, DEFAULT_PLATFORM_FEE_GST_RATE } from '../billing.js';

const round = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

// --- the agreed bill, line for line -----------------------------------------
{
    const b = computeBill({
        itemAmount: 200, deliveryFee: 25, platformFee: 10, tip: 10,
        gstRate: 5, platformFeeGstRate: 18,
    });
    assert.equal(b.itemAmount, 200);
    assert.equal(b.gstOnItems, 10, 'GST 5% on the food');
    assert.equal(b.deliveryFee, 25, 'the rider is not taxed');
    assert.equal(b.platformFee, 10);
    assert.equal(b.platformFeeGst, 1.8, 'govt fee 18% on the platform fee');
    assert.equal(b.tip, 10);
    assert.equal(b.totalBeforeTip, 246.8);
    assert.equal(b.payableBeforeRounding, 256.8);
    assert.equal(b.roundOff, 0.2);
    assert.equal(b.grandTotal, 257);
    assert.ok(billAddsUp(b));
}

// --- the lines always add up to the total -----------------------------------
// The property that matters: whatever the inputs, the printed figures reconcile.
for (const item of [0, 1, 99.99, 200, 357, 1234.56]) {
    for (const gst of [0, 5, 5.6, 18]) {
        for (const tip of [0, 10, 37.5]) {
            for (const delivery of [0, 25, 149]) {
                const b = computeBill({
                    itemAmount: item, deliveryFee: delivery, platformFee: 10, tip,
                    gstRate: gst, platformFeeGstRate: 18,
                });
                assert.ok(billAddsUp(b),
                    `does not reconcile: item ${item} gst ${gst} tip ${tip} delivery ${delivery}`);
                assert.equal(b.grandTotal, Math.round(b.grandTotal), 'the grand total is a whole rupee');
                assert.ok(Math.abs(b.roundOff) <= 0.5 + 1e-9, `round off out of range: ${b.roundOff}`);
            }
        }
    }
}

// --- rounding is at the END, not per line -----------------------------------
{
    // 5.6% of 357 is 19.992. The old code rounded that to 20 immediately; the
    // bill now carries the paise and settles up once at the bottom.
    const b = computeBill({ itemAmount: 357, gstRate: 5.6, deliveryFee: 25, platformFee: 10 });
    assert.equal(b.gstOnItems, 19.99, 'the tax line keeps its paise');
    assert.ok(billAddsUp(b));
}

// --- what is and is not taxed ------------------------------------------------
{
    const b = computeBill({ itemAmount: 100, deliveryFee: 50, tip: 20, platformFee: 0, gstRate: 10 });
    assert.equal(b.gstOnItems, 10, 'only the food is taxed');
    assert.equal(b.platformFeeGst, 0, 'no platform fee, no fee tax');
    // Delivery 50 and tip 20 contributed nothing to tax.
    assert.equal(b.grandTotal, Math.round(100 + 10 + 50 + 20));
}

// --- discount comes off before tax ------------------------------------------
{
    const b = computeBill({ itemAmount: 200, discount: 50, gstRate: 10, platformFee: 0 });
    assert.equal(b.taxableAmount, 150);
    assert.equal(b.gstOnItems, 15, 'tax follows the discounted food, not the list price');
}
// A coupon cannot exceed the food it discounts.
{
    const b = computeBill({ itemAmount: 100, discount: 500, gstRate: 5 });
    assert.equal(b.discount, 100);
    assert.equal(b.taxableAmount, 0);
    assert.equal(b.gstOnItems, 0);
    assert.ok(b.grandTotal >= 0, 'never negative');
}

// --- packaging and surge sit with the food ----------------------------------
{
    const b = computeBill({ itemAmount: 100, packagingFee: 10, surgeAmount: 20, gstRate: 10, platformFee: 0 });
    assert.equal(b.taxableAmount, 130);
    assert.equal(b.gstOnItems, 13);
}

// --- tips --------------------------------------------------------------------
assert.equal(normalizeTip(0), 0);
assert.equal(normalizeTip(-5), 0, 'a negative tip is no tip');
assert.equal(normalizeTip('abc'), 0);
assert.equal(normalizeTip(null), 0);
assert.equal(normalizeTip(12.345), 12.35, 'rounded to paise');
assert.equal(normalizeTip(999999), MAX_TIP, 'capped, so a fat finger cannot bill a fortune');

// --- defaults and junk -------------------------------------------------------
assert.equal(DEFAULT_PLATFORM_FEE_GST_RATE, 18);
{
    const b = computeBill();
    assert.equal(b.grandTotal, 0);
    assert.ok(billAddsUp(b));
}
{
    // Nonsense in, zeroes out -- never NaN on a bill.
    const b = computeBill({ itemAmount: 'x', deliveryFee: null, platformFee: undefined, gstRate: 'y', tip: {} });
    for (const [k, v] of Object.entries(b)) {
        assert.ok(Number.isFinite(Number(v)), `${k} is not a number: ${v}`);
    }
}
// A rate above 100 is a typo, not a tax.
assert.equal(computeBill({ itemAmount: 100, gstRate: 5000 }).gstOnItems, 100);

// --- GST-inclusive menus -----------------------------------------------------
// The customer still pays the listed price; the tax comes out of it.
{
    const b = computeBill({
        itemAmount: 200, deliveryFee: 25, platformFee: 10, tip: 10,
        gstRate: 5, platformFeeGstRate: 18, pricesIncludeGst: true,
    });
    assert.equal(b.listedFoodAmount, 200, 'the menu price is unchanged');
    assert.equal(b.taxableAmount, 190.48, 'the restaurant earns the net');
    assert.equal(b.gstOnItems, 9.52, 'the tax was inside the 200');
    assert.equal(round(b.taxableAmount + b.gstOnItems), 200, 'net + tax is the listed price');
    assert.ok(billAddsUp(b));
}

// Extracting is NOT the same sum as adding. Taking 5% off the gross would give
// 10.00 and overstate the tax on every inclusive dish.
{
    const inc = computeBill({ itemAmount: 200, gstRate: 5, pricesIncludeGst: true, platformFee: 0 });
    const exc = computeBill({ itemAmount: 200, gstRate: 5, pricesIncludeGst: false, platformFee: 0 });
    assert.equal(inc.gstOnItems, 9.52);
    assert.equal(exc.gstOnItems, 10);
    assert.notEqual(inc.gstOnItems, exc.gstOnItems, 'extraction and addition must differ');
    // And the customer pays a different total for the same listed price.
    assert.equal(inc.grandTotal, 200);
    assert.equal(exc.grandTotal, 210);
}

// The default is exclusive, so nothing that predates the flag moves.
{
    const withFlag = computeBill({ itemAmount: 200, gstRate: 5, platformFee: 0, pricesIncludeGst: false });
    const without = computeBill({ itemAmount: 200, gstRate: 5, platformFee: 0 });
    assert.deepEqual(without, withFlag, 'omitting the flag behaves exactly as exclusive');
}

// A coupon comes off before the tax is extracted, so the customer is not taxed
// on money nobody paid.
{
    const b = computeBill({ itemAmount: 200, discount: 100, gstRate: 5, pricesIncludeGst: true, platformFee: 0 });
    assert.equal(b.listedFoodAmount, 100);
    assert.equal(round(b.taxableAmount + b.gstOnItems), 100);
    assert.equal(b.grandTotal, 100);
}

// Zero rate: inclusive and exclusive are the same thing.
{
    const inc = computeBill({ itemAmount: 200, gstRate: 0, pricesIncludeGst: true, platformFee: 0 });
    assert.equal(inc.gstOnItems, 0);
    assert.equal(inc.taxableAmount, 200);
}

// The reconciliation property has to hold for inclusive menus too.
for (const item of [1, 99.99, 200, 357, 1234.56]) {
    for (const gst of [0, 5, 5.6, 12, 18]) {
        for (const tip of [0, 10]) {
            const b = computeBill({
                itemAmount: item, deliveryFee: 25, platformFee: 10, tip,
                gstRate: gst, platformFeeGstRate: 18, pricesIncludeGst: true,
            });
            assert.ok(billAddsUp(b), `inclusive bill does not reconcile: ${item} @ ${gst}% tip ${tip}`);
            // The food half always sums back to what was listed, within a paisa
            // of rounding.
            const food = round(b.taxableAmount + b.gstOnItems);
            assert.ok(Math.abs(food - b.listedFoodAmount) < 0.02,
                `net + tax ${food} should be the listed ${b.listedFoodAmount}`);
        }
    }
}

console.log('All billing checks passed.');
