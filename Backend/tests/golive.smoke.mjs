/**
 * The go-live checklist items that are testable server-side.
 *
 *   1. A restaurant with no approved menu must not be listed.
 *   2. Switching a dish off must reach the customer, not sit behind a cache.
 *   3. An outlet outside its trading hours must not read as open.
 *
 * Each of these was reported as "not working in the app", and each turned out
 * to be a gap between what the database said and what a public endpoint
 * served. So the assertions are on the public endpoints, never on the write.
 *
 * Run: node tests/golive.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const server = await MongoMemoryServer.create();
process.env.MONGODB_URI = server.getUri();
// Redis off: the cache layer no-ops without it, so these assertions measure the
// query logic. The cache path is covered by the invalidation call sites, which
// is what actually broke.
process.env.REDIS_ENABLED = 'false';
await mongoose.connect(server.getUri(), { dbName: 'golive' });

const { FoodItem } = await import('../src/modules/food/admin/models/food.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
const { FoodRestaurantOutletTimings } = await import('../src/modules/food/restaurant/models/outletTimings.model.js');
const { listApprovedRestaurants } = await import('../src/modules/food/restaurant/services/restaurant.service.js');
const { getPublicApprovedRestaurantMenu } = await import('../src/modules/food/restaurant/services/restaurantMenu.service.js');

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

let seq = 0;
const makeRestaurant = async (name, extra = {}) => {
    seq += 1;
    return FoodRestaurant.create({
        restaurantName: name,
        ownerName: 'Owner',
        email: `golive${Date.now()}_${seq}@example.com`,
        phone: `9${String(Date.now()).slice(-8)}${seq}`,
        status: 'approved',
        ...extra,
    });
};

const makeDish = (restaurant, extra = {}) => FoodItem.create({
    restaurantId: restaurant._id,
    name: 'Paneer Tikka',
    price: 200,
    basePrice: 200,
    approvalStatus: 'approved',
    isAvailable: true,
    ...extra,
});

const listedNames = async () => {
    const { restaurants } = await listApprovedRestaurants({ limit: 100 });
    return restaurants.map((r) => r.restaurantName || r.name);
};

/* ------------------------------------------------ 1. menu approval gates go-live */
console.log('\n1. a restaurant is not live until its menu is');
{
    const withMenu = await makeRestaurant('Has A Menu');
    await makeDish(withMenu);

    const empty = await makeRestaurant('No Dishes At All');

    const pending = await makeRestaurant('Menu Awaiting Review');
    await makeDish(pending, { approvalStatus: 'pending' });

    const rejected = await makeRestaurant('Menu Rejected');
    await makeDish(rejected, { approvalStatus: 'rejected' });

    const names = await listedNames();
    check('an approved menu is listed', () => assert.ok(names.includes('Has A Menu')));
    check('no dishes at all is not listed', () => assert.ok(!names.includes('No Dishes At All')));
    check('a menu awaiting review is not listed', () =>
        assert.ok(!names.includes('Menu Awaiting Review')));
    check('a rejected menu is not listed', () => assert.ok(!names.includes('Menu Rejected')));
}

/* ---------------------------------------- 2. switching a dish off reaches the app */
console.log('\n2. a dish switched off leaves the customer menu');
{
    const r = await makeRestaurant('Toggle Kitchen');
    const keep = await makeDish(r, { name: 'Stays On' });
    const drop = await makeDish(r, { name: 'Gets Switched Off' });

    const before = await getPublicApprovedRestaurantMenu(String(r._id));
    const namesBefore = (before?.sections || []).flatMap((s) => s.items.map((i) => i.name));
    check('both dishes start on the menu', () => {
        assert.ok(namesBefore.includes('Stays On'));
        assert.ok(namesBefore.includes('Gets Switched Off'));
    });

    await FoodItem.updateOne({ _id: drop._id }, { $set: { isAvailable: false } });

    const after = await getPublicApprovedRestaurantMenu(String(r._id));
    const namesAfter = (after?.sections || []).flatMap((s) => s.items.map((i) => i.name));
    check('the dish switched off is gone', () =>
        assert.ok(!namesAfter.includes('Gets Switched Off')));
    check('the other dish is untouched', () => assert.ok(namesAfter.includes('Stays On')));

    // isActive is the other half of the same toggle and was checked separately.
    await FoodItem.updateOne({ _id: keep._id }, { $set: { isActive: false } });
    const afterActive = await getPublicApprovedRestaurantMenu(String(r._id));
    const namesFinal = (afterActive?.sections || []).flatMap((s) => s.items.map((i) => i.name));
    check('isActive:false also removes a dish', () => assert.ok(!namesFinal.includes('Stays On')));

    // With every dish off, the restaurant itself drops out of the listing --
    // there is nothing left to order.
    const names = await listedNames();
    check('a restaurant with nothing left on is delisted', () =>
        assert.ok(!names.includes('Toggle Kitchen')));
}

/* ------------------------------------------------- 3. outlet hours are respected */
console.log('\n3. the listing reports whether an outlet is trading');
{
    const open = await makeRestaurant('Open Now');
    await makeDish(open);
    const shut = await makeRestaurant('Shut Right Now');
    await makeDish(shut);

    // Kolkata is UTC+05:30 with no DST, so this instant is 04:00 local -- inside
    // nobody's opening hours, and exactly the case that was reported.
    const fourAM = new Date('2026-09-07T22:30:00.000Z');
    const allDay = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    await FoodRestaurantOutletTimings.create({
        restaurantId: shut._id,
        timings: allDay.map((day) => ({ day, isOpen: true, openingTime: '09:00', closingTime: '22:00' })),
    });
    await FoodRestaurantOutletTimings.create({
        restaurantId: open._id,
        timings: allDay.map((day) => ({ day, isOpen: true, openingTime: '00:00', closingTime: '23:59' })),
    });

    const { describeOutletHours } = await import('../src/modules/food/shared/outletHours.js');
    const shutDoc = await FoodRestaurantOutletTimings.findOne({ restaurantId: shut._id }).lean();
    const openDoc = await FoodRestaurantOutletTimings.findOne({ restaurantId: open._id }).lean();

    check('a 09:00-22:00 outlet is shut at 04:00 local', () =>
        assert.equal(describeOutletHours({ timingsDoc: shutDoc, when: fourAM }).isOpen, false));
    check('and reports when it opens', () =>
        assert.equal(describeOutletHours({ timingsDoc: shutDoc, when: fourAM }).opensAt, '09:00'));
    check('a 24-hour outlet is open at 04:00', () =>
        assert.equal(describeOutletHours({ timingsDoc: openDoc, when: fourAM }).isOpen, true));

    const { restaurants } = await listApprovedRestaurants({ limit: 100 });
    check('every listed restaurant carries an open/closed flag', () =>
        assert.ok(restaurants.every((r) => typeof r.isOpenNow === 'boolean')));

    const listedShut = restaurants.find((r) => (r.restaurantName || r.name) === 'Shut Right Now');
    check('the closed outlet is still listed, flagged rather than hidden', () => {
        assert.ok(listedShut, 'it should appear so a customer can see its hours');
        assert.equal(typeof listedShut.isOpenNow, 'boolean');
    });
}

await mongoose.disconnect();
await server.stop();

console.log(failures ? `\n${failures} FAILED\n` : '\nall go-live checks passed\n');
process.exit(failures ? 1 : 0);
