/**
 * An admin corrects what a rider signed up as (section, services, vehicle):
 * PATCH /food/admin/delivery/:id/vehicle -> updateDeliveryPartnerVehicle.
 *
 * Run: node tests/rider-vehicle-edit.smoke.mjs
 *
 * The case: a Splendor rider who signed up under "vehicle for parcels" could
 * only pick Heavy Truck and showed as heavy parcel, approved for passengers,
 * with no way for anyone to change it (2026-11-19).
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let failed = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  PASS  ${label}`); }
    catch (err) { failed += 1; console.log(`  FAIL  ${label}\n        ${err.stack?.split('\n').slice(0, 2).join(' | ')}`); }
};

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
await mongoose.connect(replSet.getUri(), { dbName: 'rider_vehicle_edit' });

const admin = await import('../src/modules/food/admin/services/admin.service.js');
const { FoodDeliveryPartner } = await import('../src/modules/food/delivery/models/deliveryPartner.model.js');
const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');

const vid = () => new mongoose.Types.ObjectId();
const truck = vid();
const bike = vid();
await Vehicle.collection.insertMany([
    { _id: truck, name: 'Heavy Truck', icon_types: 'truck', transport_type: 'delivery', status: 1, active: true },
    { _id: bike, name: 'Bike', icon_types: 'bike', transport_type: 'both', status: 1, active: true },
]);

const partner = await FoodDeliveryPartner.create({
    name: 'Deepak Singh', phone: '9876500011', countryCode: '+91', status: 'approved',
    driverClass: 'parcel_vehicle', serviceIntents: ['parcel_delivery'],
    vehicleType: String(truck), vehicleName: 'Splendor', vehicleNumber: 'HP37C 8476',
});
// As approved today: linked driver carrying passenger rides only.
await admin.updateDeliveryPartnerCapabilities(String(partner._id), ['taxi']);
const before = await Driver.findById((await FoodDeliveryPartner.findById(partner._id)).driverId).lean();

await check('the starting point is the bug: a truck, heavy parcel class, passengers only', () => {
    assert.equal(before.vehicleType, 'truck');
    assert.equal(before.driverClass, 'parcel_vehicle');
    assert.deepEqual(before.serviceCapabilities, ['taxi']);
});

let saved;
await check('the admin moves him to 2 wheeler, Food + Daily + Medical + Bike parcel, on a Bike', async () => {
    saved = await admin.updateDeliveryPartnerVehicle(String(partner._id), {
        driverClass: 'two_wheeler',
        serviceIntents: ['food_daily_medical_parcel'],
        vehicleType: String(bike),
        vehicleName: 'Splendor',
        vehicleNumber: 'hp37c 8476',
    });
    assert.equal(saved.driverClass, 'two_wheeler');
    assert.deepEqual(saved.serviceIntents, ['food_daily_medical_parcel']);
    assert.equal(saved.vehicleType, String(bike));
    assert.equal(saved.vehicleNumber, 'HP37C 8476');
    assert.equal(saved.vehicleTypeName, 'Bike');
});
await check('the linked driver follows: bike, two wheeler, food + daily + parcel, no passengers', async () => {
    const d = await Driver.findById(saved.driverId).lean();
    assert.equal(d.vehicleType, 'bike');
    assert.equal(d.driverClass, 'two_wheeler');
    assert.deepEqual([...d.serviceCapabilities].sort(), ['delivery', 'parcel', 'quickCommerce']);
    assert.equal(d.delivery?.vehicleType, String(bike));
    assert.equal(d.delivery?.vehicleNumber, 'HP37C 8476');
    assert.equal(d.workMode, 'all', 'comes online for food, groceries and parcels, not stuck in taxi');
});
await check('a vehicle that does not fit the section is refused', async () => {
    await assert.rejects(
        admin.updateDeliveryPartnerVehicle(String(partner._id), { driverClass: 'two_wheeler', serviceIntents: ['food_daily_medical_parcel'], vehicleType: String(truck) }),
        /Heavy Truck is not a vehicle for/,
    );
});
await check('services from another section are dropped, and none at all is refused', async () => {
    await assert.rejects(
        admin.updateDeliveryPartnerVehicle(String(partner._id), { driverClass: 'two_wheeler', serviceIntents: ['heavy_parcel_delivery'], vehicleType: String(bike) }),
        /at least one service/,
    );
});
await check('the admin can still grant a narrower set explicitly', async () => {
    const r = await admin.updateDeliveryPartnerVehicle(String(partner._id), {
        driverClass: 'two_wheeler', serviceIntents: ['food_daily_medical_parcel'], vehicleType: String(bike), serviceCapabilities: ['delivery', 'parcel'],
    });
    assert.deepEqual([...r.serviceCapabilities].sort(), ['delivery', 'parcel']);
});

await mongoose.disconnect();
await replSet.stop();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
