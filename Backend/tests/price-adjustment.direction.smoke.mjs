/**
 * What a global price adjustment shows the customer, in both directions.
 *
 * Drives the real service against a real in-memory Mongo and then asks the real
 * display function what the menu renders, because every bug this covers lived in
 * the gap between "the run wrote a number" and "the customer saw it":
 *
 *   - a +20% run measured its percentage from the LAST run's output, so running
 *     it twice advertised 44% off and five times 149% off;
 *   - a decrease overwrote the restaurant's own base price with the reduced
 *     figure, so the next run cut again from that, and the price the restaurant
 *     typed stopped existing anywhere;
 *   - a marked-down dish then displayed a stale comparison larger than either.
 *
 * None of that is visible by checking that updateMany reported rows modified,
 * which is why this asserts on the struck-through price and nothing else.
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
const { resolveItemDisplayPricing } = await import('../src/modules/food/shared/itemDiscountPricing.js');

/** What the menu renders, via the same function every API response calls. */
const shownFor = async (itemId) => {
    const item = await FoodItem.findById(itemId).lean();
    return { ...resolveItemDisplayPricing(item), stored: item };
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
    const id = await seed({ price: 200, basePrice: 200 });
    await run(20);
    const s = await shownFor(id);
    check('still charges 200', () => assert.equal(s.price, 200));
    check('strikes through 240', () => assert.equal(s.strikePrice, 240));
    check('reads as 17% off', () => assert.equal(s.discountPercent, 16.67));
    check('stores the percent, not a product', () => assert.equal(s.stored.formulationPercent, 20));

    // The reported bug: the same +20% run twice doubled the saving. Nothing the
    // admin typed said "and remember the last time".
    await run(20);
    await run(20);
    const again = await shownFor(id);
    check('three +20% runs still strike 240', () => assert.equal(again.strikePrice, 240));
    check('three +20% runs still charge 200', () => assert.equal(again.price, 200));
    check('the base never moved', () => assert.equal(again.stored.basePrice, 200));
}

/* ---------------------------------------------------------------- decrease */
console.log('\n-20% on a Rs 200 dish -> pays 160, struck 200');
{
    const id = await seed({ price: 200, basePrice: 200 });
    await run(-20);
    const s = await shownFor(id);
    check('charges 160', () => assert.equal(s.price, 160));
    check('strikes through 200', () => assert.equal(s.strikePrice, 200));
    check('reads as 20% off', () => assert.equal(s.discountPercent, 20));
    check('keeps the base at 200', () => assert.equal(s.stored.basePrice, 200));
}

console.log('\n-10% on a Rs 200 dish -> pays 180, struck 200');
{
    const id = await seed({ price: 200, basePrice: 200 });
    await run(-10);
    const s = await shownFor(id);
    check('charges 180', () => assert.equal(s.price, 180));
    check('strikes through 200', () => assert.equal(s.strikePrice, 200));
}

/* --------------------------------------------- the property this exists for */
console.log('\nno run inherits another');
{
    const id = await seed({ price: 200, basePrice: 200 });
    await run(20);
    await run(-10);
    const s = await shownFor(id);
    check('+20% then -10% measures from 200', () => assert.equal(s.price, 180));
    check('and strikes 200, not a stale 240', () => assert.equal(s.strikePrice, 200));

    await run(-50);
    await run(0.0001);
    const back = await shownFor(id);
    check('a percent near zero returns the dish to its own price', () =>
        assert.equal(back.price, 200));
    check('and strikes nothing', () => assert.equal(back.strikePrice, null));
}

console.log('\nrepeat decreases do not ratchet the base down');
{
    // Rainbow Restro as it actually stood: Rs 153 off its own Rs 170. One
    // platform-wide -10% used to leave it at Rs 137.70 off Rs 153, with the
    // Rs 170 gone from the menu and from the Edit Food form.
    const id = await seed({ price: 153, basePrice: 170, discountPercent: 10 });
    await run(-10);
    const once = await shownFor(id);
    check('keeps the restaurant base of 170', () => assert.equal(once.stored.basePrice, 170));
    check('charges 153', () => assert.equal(once.price, 153));

    await run(-10);
    await run(-10);
    const thrice = await shownFor(id);
    check('three runs later the base is still 170', () => assert.equal(thrice.stored.basePrice, 170));
    check('and the price has not ratcheted', () => assert.equal(thrice.price, 153));
}

/* ------------------------------------------------- an un-migrated legacy row */
console.log('\na row the backfill has not reached');
{
    // No formulationPercent at all: the adjustment lives in the price/base gap.
    // The field has to be removed rather than left at 0, because that is the
    // actual state of every row in the database -- the schema default only
    // applies to documents Mongoose creates, and an explicit 0 means "this dish
    // was migrated and is deliberately unadjusted", which is a different thing.
    const id = await seed({ price: 137.7, basePrice: 153 });
    await FoodItem.collection.updateOne(
        { _id: id },
        { $unset: { formulationPercent: '', formulationPrice: '' } },
    );
    const before = await shownFor(id);
    check('charges what it charged, not the base', () => assert.equal(before.price, 137.7));
    check('strikes its own base', () => assert.equal(before.strikePrice, 153));
    check('reports the percent it is effectively sold at', () =>
        assert.equal(before.formulationPercent, -10));

    await run(-20);
    const after = await shownFor(id);
    check('a run measures from the base, not the reduced price', () =>
        assert.equal(after.price, 122.4));
    check('and strikes the base', () => assert.equal(after.strikePrice, 153));
}

/* ------------------------------------------------------------------ variants */
console.log('\nvariants follow the dish');
{
    const id = await seed({
        price: 120,
        basePrice: 120,
        variantsEnabled: true,
        variants: [{ name: 'Half', price: 120 }, { name: 'Full', price: 200 }],
    });
    await run(-25);
    const s = await shownFor(id);
    check('each size is cut', () => {
        const prices = s.stored.variants.map((v) => v.price).sort((a, b) => a - b);
        assert.deepEqual(prices, [90, 150]);
    });
    check('each size keeps its own base', () => {
        const bases = s.stored.variants.map((v) => v.basePrice).sort((a, b) => a - b);
        assert.deepEqual(bases, [120, 200]);
    });

    await run(-25);
    await run(-25);
    const again = await shownFor(id);
    check('repeat runs do not ratchet a size down', () => {
        const prices = again.stored.variants.map((v) => v.price).sort((a, b) => a - b);
        assert.deepEqual(prices, [90, 150]);
    });

    await run(20);
    const up = await shownFor(id);
    check('an increase never raises what a size charges', () => {
        const prices = up.stored.variants.map((v) => v.price).sort((a, b) => a - b);
        assert.deepEqual(prices, [120, 200]);
    });
}

/* ------------------------------------------------------------------ revert */
console.log('\nrevert puts the dish back');
{
    const id = await seed({ price: 200, basePrice: 250, discountPercent: 20 });
    const before = await FoodItem.findById(id).lean();

    const down = await run(-30);
    const cut = await shownFor(id);
    check('the run took effect', () => assert.equal(cut.price, 175));

    await revertPriceAdjustment(String(down.adjustment._id), {});
    const after = await FoodItem.findById(id).lean();
    check('price restored', () => assert.equal(after.price, before.price));
    check('base restored', () => assert.equal(after.basePrice, before.basePrice));
    check('percent restored', () =>
        assert.equal(after.formulationPercent ?? null, before.formulationPercent ?? null));
}

/* ----------------------------------------------------------------- preview */
console.log('\nthe preview describes the run that will happen');
{
    await FoodItem.deleteMany({ restaurantId: restaurant._id });
    const id = await seed({ price: 200, basePrice: 200 });

    const up = await getPriceAdjustmentPreview({ restaurantId: String(restaurant._id), percent: 20 });
    check('previews the formulation landing on 240', () => assert.equal(up.samples[0].next, 240));
    check('previews the customer still paying 200', () => assert.equal(up.samples[0].paysAfter, 200));

    await run(20);
    const actual = await shownFor(id);
    check('and the run agrees with the preview', () =>
        assert.equal(actual.strikePrice, up.samples[0].next));

    const down = await getPriceAdjustmentPreview({ restaurantId: String(restaurant._id), percent: -20 });
    check('previews a decrease landing on 160', () => assert.equal(down.samples[0].next, 160));
    check('previews the customer paying 160', () => assert.equal(down.samples[0].paysAfter, 160));
    check('previews from the base, not from the standing +20%', () =>
        assert.equal(down.samples[0].strikeAfter, 200));
}

await mongoose.disconnect();
await server.stop();

console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
