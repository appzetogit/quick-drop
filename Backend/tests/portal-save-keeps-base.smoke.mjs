/**
 * Saving a dish in the portal must not move any base price.
 *
 * Run: node tests/portal-save-keeps-base.smoke.mjs
 *
 * Reported from the live portal. Margherita Pizza: bases 120/270/390 with the
 * dish carrying 10% off, so customers pay 108/243/351. The size editor shows the
 * SELLING price -- 108/243/351 -- and posts it back as each size's price with no
 * base alongside it. Both ends then took that as the base:
 *
 *   the sizes  each size's base became its own charged price
 *   the dish   basePrice was set to the cheapest CHARGED price, 120 -> 108
 *
 * so one save cut every base by the discount, and the next save cut it again.
 *
 * These run the real service against an in-memory Mongo, replaying exactly what
 * the portal posts.
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let failed = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  PASS  ${label}`);
    } catch (err) {
        failed += 1;
        console.log(`  FAIL  ${label}\n        ${err.message}`);
    }
};

const main = async () => {
    const mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'portal_save' });

    const { normalizeFoodVariantsInput } = await import('../src/modules/food/admin/services/foodVariant.service.js');

    // The dish exactly as production holds it.
    const stored = {
        formulationDiscountPercent: 10,
        formulationMarkupPercent: 0,
        variants: [
            { _id: 'v1', name: 'Small', price: 108, basePrice: 120 },
            { _id: 'v2', name: 'Medium', price: 243, basePrice: 270 },
            { _id: 'v3', name: 'Large', price: 351, basePrice: 390 },
        ],
    };

    // What ItemDetailsPage posts: the selling price, no basePrice.
    const asPortalPosts = (variants) => variants.map((v) => ({
        _id: v._id, name: v.name, price: v.price,
    }));

    console.log('\nsaving without changing anything');

    let saved = normalizeFoodVariantsInput(asPortalPosts(stored.variants), { existing: stored });

    check('every size keeps the base the restaurant set', () => {
        assert.deepEqual(
            saved.map((v) => v.basePrice),
            [120, 270, 390],
            `got ${saved.map((v) => v.basePrice).join('/')}`,
        );
    });

    check('what customers pay is untouched', () => {
        assert.deepEqual(saved.map((v) => v.price), [108, 243, 351]);
    });

    console.log('\nsaving five times over, as an impatient admin would');

    let state = { ...stored };
    for (let i = 0; i < 5; i += 1) {
        const out = normalizeFoodVariantsInput(asPortalPosts(state.variants), { existing: state });
        state = { ...state, variants: out.map((v, idx) => ({ ...v, _id: state.variants[idx]._id })) };
    }

    check('the bases have not drifted a paisa', () => {
        assert.deepEqual(
            state.variants.map((v) => v.basePrice),
            [120, 270, 390],
            `after 5 saves: ${state.variants.map((v) => v.basePrice).join('/')}`,
        );
    });

    console.log('\ndeliberately repricing a size');

    // The admin types 200 into Medium's price box. That is what a customer should
    // pay, so the base behind it is 200 / 0.9.
    const repriced = normalizeFoodVariantsInput(
        asPortalPosts(stored.variants).map((v) => (v.name === 'Medium' ? { ...v, price: 200 } : v)),
        { existing: stored },
    );

    check('the repriced size gets the base its new price implies', () => {
        const medium = repriced.find((v) => v.name === 'Medium');
        assert.equal(medium.basePrice, 222.22, '200 at 10% off comes from a base of 222.22');
    });

    check('the sizes that were not touched keep their bases', () => {
        assert.equal(repriced.find((v) => v.name === 'Small').basePrice, 120);
        assert.equal(repriced.find((v) => v.name === 'Large').basePrice, 390);
    });

    console.log('\na dish with no discount');

    const plain = {
        formulationDiscountPercent: 0,
        variants: [{ _id: 'p1', name: 'Regular', price: 150, basePrice: 150 }],
    };
    const plainSaved = normalizeFoodVariantsInput(asPortalPosts(plain.variants), { existing: plain });

    check('base and price stay equal', () => {
        assert.equal(plainSaved[0].basePrice, 150);
        assert.equal(plainSaved[0].price, 150);
    });

    console.log('\na brand new size added to a discounted dish');

    const withNew = normalizeFoodVariantsInput(
        [...asPortalPosts(stored.variants), { name: 'Party', price: 450 }],
        { existing: stored },
    );

    check('the new size prices off the discount, the others are untouched', () => {
        const party = withNew.find((v) => v.name === 'Party');
        assert.equal(party.basePrice, 500, '450 at 10% off comes from a base of 500');
        assert.deepEqual(
            withNew.filter((v) => v.name !== 'Party').map((v) => v.basePrice),
            [120, 270, 390],
        );
    });

    console.log('\na client that does send a real base');

    const explicit = normalizeFoodVariantsInput(
        [{ _id: 'v1', name: 'Small', price: 108, basePrice: 130 }],
        { existing: stored },
    );

    check('an explicit base wins over everything', () => {
        assert.equal(explicit[0].basePrice, 130);
    });

    await mongoose.disconnect();
    await mongo.stop();

    console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failed ? 1 : 0);
};

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
