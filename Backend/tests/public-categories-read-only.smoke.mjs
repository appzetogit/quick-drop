/**
 * Listing the public categories must not write to them.
 *
 * The public list loads only the fields it shows, and the legacy backfill read
 * the missing approvalStatus as "never set": every load re-saved the category
 * as approved, moved approvedAt to its last update and bumped updatedAt.
 *
 * Run: node tests/public-categories-read-only.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'public_categories_read_only' });

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();
const then = new Date('2026-10-13T00:00:00Z');

const verticals = [
    ['food', '../src/modules/food'],
    ['quick commerce', '../src/modules/quickCommerce/modules/food'],
];
for (const [label, root] of verticals) {
    const { FoodRestaurant } = await import(`${root}/restaurant/models/restaurant.model.js`);
    const { FoodCategory } = await import(`${root}/admin/models/category.model.js`);
    const { FoodItem } = await import(`${root}/admin/models/food.model.js`);
    const { listPublicCategories } = await import(`${root}/restaurant/services/restaurantCategory.service.js`);

    const rid = oid();
    const cid = oid();
    await FoodRestaurant.collection.insertOne({
        _id: rid, restaurantName: 'Test', status: 'approved', location: { type: 'Point', coordinates: [76.5, 32.1] },
    });
    await FoodCategory.collection.insertOne({
        _id: cid, name: 'Chaat', foodTypeScope: 'Both', approvalStatus: 'approved', isApproved: true, isActive: true,
        restaurantId: null, sortOrder: 0, approvedAt: then, createdAt: then, updatedAt: then,
    });
    await FoodItem.collection.insertOne({
        _id: oid(), name: 'Tikki', restaurantId: rid, categoryId: cid, approvalStatus: 'approved', isAvailable: true, isActive: true, price: 50,
    });

    const { categories } = await listPublicCategories({});
    await check(`${label}: the category is listed`, async () => {
        assert.deepEqual(categories.map((c) => c.name), ['Chaat']);
    });
    await check(`${label}: listing it changes nothing on it`, async () => {
        const after = await FoodCategory.collection.findOne({ _id: cid });
        assert.equal(after.approvedAt.toISOString(), then.toISOString());
        assert.equal(after.updatedAt.toISOString(), then.toISOString());
    });
}

await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
