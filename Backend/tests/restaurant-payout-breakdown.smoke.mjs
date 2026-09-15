/**
 * What the restaurant app shows the restaurant it earned, against what the
 * payout ledger actually credits it.
 *
 * Run: node tests/restaurant-payout-breakdown.smoke.mjs
 *
 * The restaurant's order screen showed the CUSTOMER's bill -- delivery fee,
 * platform fee, grand total -- none of which the restaurant is paid. It now
 * shows its own: food, the GST inside or on top of it, packaging, commission,
 * and the payout. Every figure has to agree with foodTransaction.service.js,
 * which is what actually pays; a payout screen that disagrees with the payout
 * is worse than no screen.
 *
 * The bill is built by the real computeBill and mapped exactly as
 * order-pricing.service.js maps it onto the order.
 */
import assert from 'node:assert/strict';
import { computeBill } from '../src/modules/food/shared/billing.js';
import { buildRestaurantPayoutBreakdown } from '../src/modules/food/shared/restaurantPayout.js';

let failures = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  ok   ${label}`);
    } catch (err) {
        failures += 1;
        console.log(`  FAIL ${label}\n       ${err.message}`);
    }
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** An order as the pricing service stores it, from a real bill. */
const orderFrom = ({ commissionPercent = 10, packagingMode = 'RESTAURANT', ...billInput }) => {
    const bill = computeBill({ deliveryFee: 25, platformFee: 10, ...billInput });
    const restaurantCommission = round2(bill.commissionBase * (commissionPercent / 100));
    return {
        _id: 'order-1',
        pricing: {
            subtotal: bill.itemAmount,
            packagingFee: bill.packagingFee,
            tax: bill.gstOnItems,
            deliveryFee: bill.deliveryFee,
            platformFee: bill.platformFee,
            discount: bill.discount,
            total: bill.grandTotal,
            bill,
            commissionableAmount: bill.commissionBase,
            pricesIncludeGst: bill.pricesIncludeGst,
            packagingMode,
            netItemAmount: bill.netItemAmount,
            netPackagingFee: bill.netPackagingFee,
            gstRate: bill.gstRate,
            restaurantCommission,
        },
    };
};

/**
 * The ledger's own sum, transcribed from foodTransaction.service.js:
 *   food net of GST + the restaurant's packaging - commission - what a
 *   coupon it funded took off.
 */
const ledgerPayout = (order, fundedDiscount = 0) => {
    const p = order.pricing;
    const food = Number(p.commissionableAmount ?? p.subtotal) || 0;
    const mode = String(p.packagingMode || '');
    const packaging = mode === '' || mode === 'RESTAURANT'
        ? Number(p.netPackagingFee ?? p.packagingFee) || 0
        : 0;
    return round2(food + packaging - (Number(p.restaurantCommission) || 0) - fundedDiscount);
};

console.log('\nRs 100 of food, prices EXCLUDE GST, 5% GST, Rs 5 packing, 10% commission');
{
    const order = orderFrom({ itemAmount: 100, packagingFee: 5, gstRate: 5, pricesIncludeGst: false });
    const b = buildRestaurantPayoutBreakdown(order);
    check('sub total is the Rs 100 listed', () => assert.equal(b.subTotal, 100));
    check('GST is Rs 5, added on top and collected from the customer', () => assert.equal(b.gstOnFood, 5));
    check('the whole Rs 100 is the taxable food value', () => assert.equal(b.taxableFoodValue, 100));
    check('packing Rs 5 is the restaurant\'s', () => assert.equal(b.packagingCharge, 5));
    check('commission is Rs 10, charged on the food only', () => assert.equal(b.commissionAmount, 10));
    check('shown as 10%', () => assert.equal(b.commissionPercent, 10));
    check('PAY TO YOU is Rs 95', () => assert.equal(b.payout, 95));
    check('  and that is exactly what the ledger credits', () => assert.equal(b.payout, ledgerPayout(order)));
}

console.log('\nthe same Rs 100, prices INCLUDE GST');
{
    const order = orderFrom({ itemAmount: 100, packagingFee: 5, gstRate: 5, pricesIncludeGst: true });
    const b = buildRestaurantPayoutBreakdown(order);
    check('sub total is still the Rs 100 the customer was charged', () => assert.equal(b.subTotal, 100));
    check('the GST inside it is Rs 4.76, not Rs 5 (100 - 100/1.05, not 5% of 100)', () =>
        assert.equal(b.gstOnFood, 4.76));
    check('taxable food value is Rs 95.24', () => assert.equal(b.taxableFoodValue, 95.24));
    check('commission is 10% of that, Rs 9.52 -- never a cut of the tax', () =>
        assert.equal(b.commissionAmount, 9.52));
    check('PAY TO YOU is Rs 90.72', () => assert.equal(b.payout, 90.72));
    check('  and that is exactly what the ledger credits', () => assert.equal(b.payout, ledgerPayout(order)));
    check('the customer paid the same Rs 100 either way', () =>
        assert.equal(order.pricing.subtotal, 100));
}

console.log('\npacking the platform sets and keeps');
{
    const order = orderFrom({ itemAmount: 100, packagingFee: 5, gstRate: 5, packagingMode: 'ADMIN' });
    const b = buildRestaurantPayoutBreakdown(order);
    check('THE BUG IT PREVENTS: it is not promised to the restaurant', () => {
        assert.equal(b.packagingCharge, 0);
        assert.equal(b.packagingIsRestaurants, false);
    });
    check('payout is food less commission, Rs 90', () => assert.equal(b.payout, 90));
    check('  matching the ledger', () => assert.equal(b.payout, ledgerPayout(order)));
}

console.log('\na coupon');
{
    const order = orderFrom({ itemAmount: 100, packagingFee: 5, gstRate: 5, discount: 20 });
    const platformFunded = buildRestaurantPayoutBreakdown(order);
    check('the platform\'s coupon costs the restaurant nothing', () => {
        assert.equal(platformFunded.discountFundedByRestaurant, 0);
        assert.equal(platformFunded.payout, 95);
        assert.equal(platformFunded.payout, ledgerPayout(order));
    });
    const funded = order.pricing.bill.discountOnNet;
    const restaurantFunded = buildRestaurantPayoutBreakdown(order, { restaurantFundedDiscount: funded });
    check('its own coupon comes off its payout, at what it took off the net lines', () => {
        assert.equal(restaurantFunded.discountFundedByRestaurant, round2(funded));
        assert.equal(restaurantFunded.payout, ledgerPayout(order, funded));
        assert.ok(restaurantFunded.payout < platformFunded.payout);
    });
}

console.log('\nan order from before any of these fields were stored');
{
    const legacy = { _id: 'legacy', pricing: { subtotal: 200, packagingFee: 10, restaurantCommission: 20 } };
    const b = buildRestaurantPayoutBreakdown(legacy);
    check('falls back to the listed food, as the ledger does', () => {
        assert.equal(b.taxableFoodValue, 200);
        assert.equal(b.packagingCharge, 10);
        assert.equal(b.payout, 190);
        assert.equal(b.payout, ledgerPayout(legacy));
    });
    check('and claims no GST it cannot prove', () => assert.equal(b.gstOnFood, 0));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
