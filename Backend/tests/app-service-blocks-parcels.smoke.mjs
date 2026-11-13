/**
 * Master > App Services: Taxi switched off refuses rides and parcels, at the
 * quote and at booking, with the admin's reason. Switched back on, the check
 * lets them through.
 *
 * Run: node tests/app-service-blocks-parcels.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'app_service_parcels' });
const svc = await import('../src/core/appServices/appServices.service.js');
const rides = await import('../src/modules/taxi/services/rideService.js');

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.message}`); }
};
const trip = (transport_type) => ({
    pickupCoords: [76.53, 32.11], dropCoords: [76.55, 32.12], vehicleTypeIds: [],
    transport_type, service_location_id: null,
});
const closedError = /Holi break/;

const { User } = await import('../src/modules/taxi/user/models/User.js');
const customer = (await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(), name: 'Asha', phone: '9800000001' })).insertedId;

await svc.setServiceEnabled('taxi', false, { reason: 'Holi break' });
svc.clearAppServicesCache();
await check('a parcel quote is refused with the admin reason', async () => {
    await assert.rejects(rides.quoteRideFares(trip('delivery')), closedError);
});
await check('a taxi quote is refused with the admin reason', async () => {
    await assert.rejects(rides.quoteRideFares(trip('taxi')), closedError);
});
await check('a parcel booking is refused with the admin reason', async () => {
    await assert.rejects(rides.createRideRecord({
        userId: customer, vehicleTypeId: String(new mongoose.Types.ObjectId()),
        pickupCoords: [76.53, 32.11], dropCoords: [76.55, 32.12], fare: 50,
        transport_type: 'delivery', serviceType: 'parcel', paymentMethod: 'cash',
    }), closedError);
});

await svc.setServiceEnabled('taxi', true, {});
svc.clearAppServicesCache();
await check('switched back on, the service check passes for the same pickup', async () => {
    assert.equal(await svc.appServiceClosedReason('taxi', { lat: 32.11, lng: 76.53 }), '');
    await assert.doesNotReject(rides.quoteRideFares(trip('delivery')).catch((e) => {
        if (closedError.test(e.message)) throw e;
    }));
});

await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
