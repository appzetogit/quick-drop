/**
 * Whether a restaurant's menu prices include GST is set by the admin, and only
 * the admin.
 *
 * Run: node tests/gst-setting-admin-only.smoke.mjs
 *
 * The setting decides what every price on a menu means -- inclusive, a Rs 200
 * dish is billed Rs 200; exclusive, Rs 200 plus GST -- so it was taken off the
 * restaurant panel. Hiding the page is not enough on its own: the restaurant's
 * tax-settings endpoint and its own profile save could both still write it.
 * This drives the real controllers and the admin service against an in-memory
 * Mongo.
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let failed = 0;
const check = async (label, fn) => {
    try {
        await fn();
        console.log(`  PASS  ${label}`);
    } catch (err) {
        failed += 1;
        console.log(`  FAIL  ${label}\n        ${err.message}`);
    }
};

const mockRes = () => ({
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
});

const main = async () => {
    const mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'gst_admin_only' });

    const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
    const controller = await import('../src/modules/food/restaurant/controllers/restaurant.controller.js');
    const admin = await import('../src/modules/food/admin/services/admin.service.js');

    const id = new mongoose.Types.ObjectId();
    await FoodRestaurant.collection.insertOne({
        _id: id,
        restaurantName: 'Test Kitchen',
        ownerName: 'Owner',
        ownerPhone: '9999999999',
        status: 'approved',
        priceIncludesGst: false,
        location: { type: 'Point', coordinates: [76.53, 32.1] },
        createdAt: new Date(),
    });
    const stored = async () => (await FoodRestaurant.findById(id).select('priceIncludesGst').lean()).priceIncludesGst;
    const asRestaurant = (body) => ({ user: { userId: String(id) }, body });

    console.log('\nthe restaurant cannot change it');
    await check('its tax-settings endpoint refuses, and nothing is written', async () => {
        const res = mockRes();
        await controller.updateRestaurantTaxSettingsController(asRestaurant({ priceIncludesGst: true }), res, (e) => { throw e; });
        assert.equal(res.code, 403, `status ${res.code}`);
        assert.equal(await stored(), false);
    });
    await check('its own profile save ignores it', async () => {
        const res = mockRes();
        let error = null;
        await controller.updateRestaurantProfileController(asRestaurant({ priceIncludesGst: true }), res, (e) => { error = e; });
        assert.equal(error, null, `profile save failed: ${error?.message}`);
        assert.equal(await stored(), false);
    });
    await check('it can still read it', async () => {
        const res = mockRes();
        await controller.getRestaurantTaxSettingsController(asRestaurant({}), res, (e) => { throw e; });
        assert.equal(res.code, 200, `status ${res.code}`);
        assert.equal(res.body?.data?.priceIncludesGst, false);
    });

    console.log('\nthe admin can');
    await check('switches the restaurant to inclusive', async () => {
        await admin.updateRestaurantById(String(id), { priceIncludesGst: true });
        assert.equal(await stored(), true);
    });
    await check('and back to exclusive', async () => {
        await admin.updateRestaurantById(String(id), { priceIncludesGst: false });
        assert.equal(await stored(), false);
    });
    await check('a save that does not mention it leaves it alone', async () => {
        await admin.updateRestaurantById(String(id), { priceIncludesGst: true });
        await admin.updateRestaurantById(String(id), { ownerName: 'New Owner' });
        assert.equal(await stored(), true);
    });
    await check('junk is refused rather than read as exclusive', async () => {
        await assert.rejects(() => admin.updateRestaurantById(String(id), { priceIncludesGst: 'maybe' }));
        assert.equal(await stored(), true);
    });

    await mongoose.disconnect();
    await mongo.stop();

    console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failed ? 1 : 0);
};

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
