/**
 * A driver can cancel a ride until they reach the pickup.
 *
 * The driver app sends PATCH; the server listened only for POST, so every cancel
 * from the app was a 404. And only a ride still "accepted" could be cancelled, while
 * the app marks a ride "arriving" as soon as the driver sets off.
 *
 * Run: node tests/taxi-driver-cancel-ride.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(replSet.getUri(), { dbName: 'taxi_driver_cancel' });

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();

const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { cancelActiveRideByDriver, stopDispatchFlow } = await import('../src/modules/taxi/services/dispatchService.js');
const driverRoutes = (await import('../src/modules/taxi/driver/routes/driverRoutes.js')).default
    || (await import('../src/modules/taxi/driver/routes/driverRoutes.js')).driverRouter;

await Driver.syncIndexes().catch(() => {});
await Ride.syncIndexes().catch(() => {});
const driverId = oid();
await Driver.collection.insertOne({ _id: driverId, name: 'D', phone: String(Math.random()).slice(2, 12), isOnline: true, isOnRide: true, approve: true, wallet: { balance: 0 } });
const makeRide = async (liveStatus, extra = {}) => {
    const _id = oid();
    await Ride.collection.insertOne({
        _id, userId: oid(), driverId, status: 'accepted', liveStatus, fare: 46, serviceType: 'ride', transport_type: 'taxi',
        paymentMethod: 'cash', acceptedAt: new Date(), pickupLocation: { type: 'Point', coordinates: [76.54, 32.12] },
        dropLocation: { type: 'Point', coordinates: [76.55, 32.13] }, ...extra,
    });
    return _id;
};

await check('the driver app can reach it: PATCH is a route, as well as POST', async () => {
    const methods = (driverRoutes?.stack || [])
        .filter((l) => l.route?.path === '/rides/:rideId/cancel')
        .flatMap((l) => Object.keys(l.route.methods));
    assert.ok(methods.includes('patch'), `methods: ${methods}`);
    assert.ok(methods.includes('post'), `methods: ${methods}`);
});
for (const status of ['accepted', 'arriving']) {
    await check(`a ride the driver is ${status === 'accepted' ? 'yet to set off for' : 'on the way to'} can be cancelled`, async () => {
        const id = await makeRide(status);
        const { ride } = await cancelActiveRideByDriver({ rideId: String(id), driverId: String(driverId), reason: 'test' });
        stopDispatchFlow(id);
        assert.ok(ride, 'no ride returned');
        const after = await Ride.findById(id).lean();
        assert.equal(after.driverId, null);
        assert.notEqual(after.liveStatus, status);
    });
}
for (const [status, extra] of [['arrived', { arrivedAt: new Date() }], ['started', { startedAt: new Date() }]]) {
    await check(`once ${status}, the driver cannot cancel`, async () => {
        const id = await makeRide(status, extra);
        await assert.rejects(() => cancelActiveRideByDriver({ rideId: String(id), driverId: String(driverId) }), /pickup|started/);
    });
}
await check('someone else\'s ride is not found', async () => {
    const id = await makeRide('accepted');
    const { ride } = await cancelActiveRideByDriver({ rideId: String(id), driverId: String(oid()) });
    assert.equal(ride, null);
});

await new Promise((r) => setTimeout(r, 300));
await mongoose.disconnect();
await replSet.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
