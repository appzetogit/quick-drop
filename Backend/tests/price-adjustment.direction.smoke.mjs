/**
 * What a global price adjustment shows the customer, in both directions.
 *
 * Drives the real service against a real in-memory Mongo and then asks the real
 * display function what the menu renders, because every bug this covers lived in
 * the gap between "the run wrote a number" and "the customer saw it":
 *
 *   - a +20% run wrote a figure 20% above the LAST figure rather than above the
 *     price, so running it twice advertised 44% off and five times 149% off;
 *   - a -10% markdown promoted the price to the strike correctly, and the menu
 *     then displayed a stale, larger otherPrice instead -- 67 of 70 marked-down
 *     dishes on the platform were showing a comparison the markdown had not set.
 *
 * Neither is visible by checking that updateMany reported rows modified, which
 * is why this asserts on the struck-through price and nothing else.
 *
 * Run: node tests/price-adjustment.direction.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const server = await MongoMemoryServer.create();
process.env.MONGODB_URI = server.getUri();
await mongoose.connect(server.getUri(), { dbName: 'smoke' });

const { FoodItem } = await import('../src/modules/food/admin/models/food.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
const { applyPriceAdjustment, revertPriceAdjustment, getPriceAdjustmentPreview } =
    await import('../src/modules/food/admin/services/priceAdjustment.service.js');
const { resolveComparisonPrice, resolveItemOtherPlatformPrice } =
    await import('../src/modules/food/shared/otherPlatformPricing.js');

// The blanket markup is on in production at 20%, and it is what a dish with no
// stored figure falls back to. Several of the bugs only appeared through that
// fallback, so the tests run with it on.
const OTHER_PLATFORM = { isEnabled: true, markupPercent: 20, label: 'Other platforms' };

/** What the menu renders beside the price, via the same code the API calls. */
const strikeOf = async (itemId) => {
    const item = await FoodItem.findById(itemId).lean();
    const otherPlatformPrice = resolveItemOtherPlatformPrice(item, OTHER_PLATFORM);
    const comparison = resolveComparisonPrice({
        price: item.price,
        basePrice: item.basePrice,
        otherPlatformPrice,
        label: OTHER_PLATFORM.label,
    });
    return { price: item.price, ...comparison, stored: item };
};

const restaurant = await FoodRestaurant.create({
    restaurantName: 'Smoke Kitchen',
    ownerName: 'Owner',
    email: `smoke${Date.now()}@example.com`,
    phone: `9${String(Date.now()).slice(-9)}`,
});

const seed = async (fields) => {
    const doc = await FoodItem.create({
        restaurantId: restaurant._id,
        name: `Dish ${Math.random().toString(36).slice(2, 8)}`,
        price: 200,
        ...fields,
    });
    return doc._id;
};

const run = (percent) => applyPriceAdjustment({ percent, restaurantId: String(restaurant._id) }, {});

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

/* ---------------------------------------------------------------- increase */
console.log('\n+20% on a Rs 200 dish -> pays 200, struck 240');
{
    const id = await seed({ price: 200, basePrice: null, otherPrice: 0 });
    await run(20);
    const shown = await strikeOf(id);
    check('still charges 200', () => assert.equal(shown.price, 200));
    check('strikes through 240', () => assert.equal(shown.strikePrice, 240));
    check('reads as 17% off', () => assert.equal(shown.savingsPercent, 17));

    // The reported bug: the admin ran the same +20% twice and the saving
    // doubled. Nothing the admin typed said "compound".
    await run(20);
    const again = await strikeOf(id);
    check('a second +20% still strikes 240', () => assert.equal(again.strikePrice, 240));
    check('a second +20% still charges 200', () => assert.equal(again.price, 200));

    await run(20);
    const third = await strikeOf(id);
    check('a third +20% still strikes 240', () => assert.equal(third.strikePrice, 240));
}

/* ---------------------------------------------------------------- decrease */
console.log('\n-20% on a Rs 200 dish -> pays 160, struck 200');
{
    const id = await seed({ price: 200, basePrice: null, otherPrice: 0 });
    await run(-20);
    const shown = await strikeOf(id);
    check('charges 160', () => assert.equal(shown.price, 160));
    check('strikes through 200', () => assert.equal(shown.strikePrice, 200));
    check('reads as 20% off', () => assert.equal(shown.savingsPercent, 20));
    check('strike is the restaurant own price, unlabelled', () =>
        assert.equal(shown.strikeSource, 'basePrice'));
}

console.log('\n-10% on a Rs 200 dish -> pays 180, struck 200');
{
    const id = await seed({ price: 200, basePrice: null, otherPrice: 0 });
    await run(-10);
    const shown = await strikeOf(id);
    check('charges 180', () => assert.equal(shown.price, 180));
    check('strikes through 200', () => assert.equal(shown.strikePrice, 200));
}

/* ------------------------------------------------- the live production bug */
console.log('\na markdown on a dish carrying an inflated old comparison');
{
    // Paneer Tikka as it actually stood: marked down 150 -> 135, still carrying
    // 326.03 from earlier compounded runs, and the menu showed the 326.03.
    const id = await seed({ price: 150, basePrice: null, otherPrice: 326.03 });
    await run(-10);
    const shown = await strikeOf(id);
    check('charges 135', () => assert.equal(shown.price, 135));
    check('strikes 150, not the stale 326.03', () => assert.equal(shown.strikePrice, 150));
    check('does not claim to be another platform', () =>
        assert.equal(shown.strikeSource, 'basePrice'));
}

/* ------------------------------------------ the restaurant's own base price */
console.log("\na markdown does not overwrite the restaurant's own base price");
{
    // Rainbow Restro as it actually stood: Rs 153 off its own Rs 170. One
    // platform-wide -10% left it at Rs 137.70 off Rs 153 and the Rs 170 the
    // restaurant had typed was gone from the Edit Food form and the menu.
    const id = await seed({ price: 153, basePrice: 170, discountPercent: 10, otherPrice: 0 });
    await run(-10);
    const shown = await strikeOf(id);
    check('charges 137.70', () => assert.equal(shown.price, 137.7));
    check('keeps the restaurant base of 170', () => assert.equal(shown.stored.basePrice, 170));
    check('strikes 170, the price the restaurant set', () => assert.equal(shown.strikePrice, 170));
    check('reports the real saving off that base', () => assert.equal(shown.savingsPercent, 19));

    // The ratchet: the old write took its next base from the already-reduced
    // price, so every repeat cut the restaurant's number again.
    await run(-10);
    const twice = await strikeOf(id);
    check('a second run still keeps 170', () => assert.equal(twice.stored.basePrice, 170));
    check('a second run cuts the price again', () => assert.equal(twice.price, 123.93));
}

console.log('\na markdown on a dish with no base price of its own');
{
    const id = await seed({ price: 200, basePrice: null, otherPrice: 0 });
    await run(-10);
    const shown = await strikeOf(id);
    check('adopts today price as the base', () => assert.equal(shown.stored.basePrice, 200));
    check('charges 180', () => assert.equal(shown.price, 180));
    // A 10% cut against the platform's 20% blanket markup: the fallback would
    // strike 216, above the 200 anyone has ever been charged.
    check('strikes 200, not the 20% markup fallback', () => assert.equal(shown.strikePrice, 200));
    check('does not invent another platform', () => assert.equal(shown.strikeSource, 'basePrice'));
}

/* ------------------------------------------- a restaurant own bigger strike */
console.log("\nan increase leaves a restaurant's own larger strike alone");
{
    // The restaurant sells at 100 off its own 300. A +20% platform comparison
    // is 120, which is smaller; the restaurant's number must keep winning.
    const id = await seed({ price: 100, basePrice: 300, discountPercent: 66.67, otherPrice: 0 });
    await run(20);
    const shown = await strikeOf(id);
    check('keeps the 300 the restaurant set', () => assert.equal(shown.strikePrice, 300));
    check("does not touch the restaurant's base price", () =>
        assert.equal(shown.stored.basePrice, 300));
    check("does not touch the restaurant's discount", () =>
        assert.equal(shown.stored.discountPercent, 66.67));
}

/* ------------------------------------------------------------------ revert */
console.log('\nrevert puts both directions back');
{
    const id = await seed({ price: 200, basePrice: 250, discountPercent: 20, otherPrice: 275 });
    const before = await FoodItem.findById(id).lean();

    const up = await run(20);
    await revertPriceAdjustment(String(up.adjustment._id), {});
    const afterUp = await FoodItem.findById(id).lean();
    check('increase then revert restores the comparison', () =>
        assert.equal(afterUp.otherPrice, before.otherPrice));
    check('increase then revert restores the price', () =>
        assert.equal(afterUp.price, before.price));

    const down = await run(-20);
    await revertPriceAdjustment(String(down.adjustment._id), {});
    const afterDown = await FoodItem.findById(id).lean();
    check('markdown then revert restores the price', () =>
        assert.equal(afterDown.price, before.price));
    check('markdown then revert restores the base price', () =>
        assert.equal(afterDown.basePrice, before.basePrice));
    check('markdown then revert restores the comparison', () =>
        assert.equal(afterDown.otherPrice, before.otherPrice));
}

/* ----------------------------------------------------------------- preview */
console.log('\nthe preview describes the run that will happen');
{
    await FoodItem.deleteMany({ restaurantId: restaurant._id });
    const id = await seed({ price: 200, basePrice: null, otherPrice: 480 });

    const up = await getPriceAdjustmentPreview({ restaurantId: String(restaurant._id), percent: 20 });
    check('preview says the comparison lands on 240', () =>
        assert.equal(up.samples[0].next, 240));
    check('preview leaves nothing without a comparison', () =>
        assert.equal(up.itemsWithoutComparison, 0));

    await run(20);
    const actual = await strikeOf(id);
    check('and the run agrees with the preview', () =>
        assert.equal(actual.strikePrice, up.samples[0].next));

    const down = await getPriceAdjustmentPreview({ restaurantId: String(restaurant._id), percent: -20 });
    check('a decrease previews the price falling to 160', () =>
        assert.equal(down.samples[0].next, 160));
    check('a decrease leaves nothing without a comparison', () =>
        assert.equal(down.itemsWithoutComparison, 0));
}

await mongoose.disconnect();
await server.stop();

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
