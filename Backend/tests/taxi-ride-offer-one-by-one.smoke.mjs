/**
 * Ride offers: one by one when set so, and taken off every phone when they end.
 *
 * With Trip Dispatch Type = One By One only the nearest driver holds an offer. A
 * driver coming online mid-round waits for the next round. When a driver accepts,
 * everyone else offered is told, by socket and by the 'order_taken' push: a phone
 * in a pocket has no socket, so without the push its card kept ringing.
 *
 * Run: node tests/taxi-ride-offer-one-by-one.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(replSet.getUri(), { dbName: 'taxi_ride_offer' });

let failures = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  ok   ${label}`); }
    catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.message}`); }
};
const oid = () => new mongoose.Types.ObjectId();

const { Ride } = await import('../src/modules/taxi/user/models/Ride.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');
const { AdminBusinessSetting } = await import('../src/modules/taxi/admin/models/AdminBusinessSetting.js');
const dispatch = await import('../src/modules/taxi/services/dispatchService.js');

// Every socket emit, as [room, event, payload].
const sent = [];
dispatch.setSocketServer({ to: (room) => ({ emit: (event, payload) => sent.push([room, event, payload]) }) });
const eventsTo = (driverId, event) => sent.filter(([room, e]) => room === `driver:${driverId}` && e === event);

const pickup = [75.8843, 22.7282];
const vehicle = oid();
const makeDriver = async (name, coordinates) => {
    const _id = oid();
    await Driver.collection.insertOne({
        _id, name, phone: String(Math.random()).slice(2, 12), isOnline: true, isOnRide: false, approve: true, status: 'approved',
        deletedAt: null, vehicleTypeId: vehicle, vehicleType: 'bike', vehicleIconType: 'bike', registerFor: 'taxi', workMode: 'taxi',
        serviceCapabilities: ['taxi'], activeAssignment: null, wallet: { balance: 0, isBlocked: false },
        location: { type: 'Point', coordinates },
    });
    return _id;
};
await Driver.syncIndexes().catch(() => {});
const near = await makeDriver('Near', [75.8844, 22.7283]);
const far = await makeDriver('Far', [75.8900, 22.7320]);
const late = await makeDriver('Late', [75.8846, 22.7284]);
// Late is offline until the round has started.
await Driver.collection.updateOne({ _id: late }, { $set: { isOnline: false } });

const setType = (type) => AdminBusinessSetting.collection.updateOne(
    { scope: 'default' },
    { $set: { scope: 'default', 'transport_ride.trip_dispatch_type': type, 'transport_ride.trip_accept_reject_duration_for_driver': '60', 'transport_ride.driver_search_radius': '5', 'transport_ride.maximum_time_for_find_drivers_for_regular_ride': '300' } },
    { upsert: true },
);
const makeRide = async () => {
    const _id = oid();
    await Ride.collection.insertOne({
        _id, userId: oid(), driverId: null, status: 'searching', liveStatus: 'searching', fare: 66, baseFare: 66, serviceType: 'ride', transport_type: 'taxi',
        vehicleTypeId: vehicle, dispatchVehicleTypeIds: [vehicle], paymentMethod: 'cash', bookingMode: 'normal',
        pickupLocation: { type: 'Point', coordinates: pickup }, dropLocation: { type: 'Point', coordinates: [75.89, 22.74] },
    });
    return Ride.findById(_id);
};

await setType('1');
const ride = await makeRide();
await dispatch.startDispatchFlow(ride);

await check('one by one: only the nearest driver is offered the ride', async () => {
    assert.equal(eventsTo(near, 'rideRequest').length, 1);
    assert.equal(eventsTo(far, 'rideRequest').length, 0);
});
await check('one by one: a driver coming online mid-round waits for the next round', async () => {
    await Driver.collection.updateOne({ _id: late }, { $set: { isOnline: true } });
    await dispatch.notifyLateAvailableDriver(late);
    assert.equal(eventsTo(late, 'rideRequest').length, 0);
    await Driver.collection.updateOne({ _id: late }, { $set: { isOnline: false } });
});
dispatch.stopDispatchFlow(ride._id);

sent.length = 0;
await setType('2');
const open = await makeRide();
await dispatch.startDispatchFlow(open);
await check('broadcast: still goes to everyone nearby', async () => {
    assert.equal(eventsTo(near, 'rideRequest').length, 1);
    assert.equal(eventsTo(far, 'rideRequest').length, 1);
});
await Ride.collection.updateOne({ _id: open._id }, { $set: { driverId: near, status: 'accepted', liveStatus: 'accepted' } });
await dispatch.notifyRideAccepted(await Ride.findById(open._id));
await check('accepted: everyone else offered is told over the socket', async () => {
    assert.equal(eventsTo(far, 'rideRequestClosed').length, 1);
});
await check('the push is the one the driver app dismisses a card on, for the losers only', async () => {
    const push = dispatch.rideOfferWithdrawalPush(open._id, [far, far]);
    assert.deepEqual(push.driverIds, [String(far)]);
    assert.equal(push.dataOnly, true);
    assert.equal(push.data.type, 'order_taken');
    assert.equal(push.data.orderMongoId, String(open._id));
    assert.equal(dispatch.rideOfferWithdrawalPush(open._id, []), null);
});

const waitFor = async (test, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await test()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
};

// A declined ride moves on at once: the window here is 60 s, so waiting it out
// would fail these.
sent.length = 0;
await setType('1');
const declined = await makeRide();
await dispatch.startDispatchFlow(declined);
dispatch.markDriverRejectedFromDispatch(declined._id, near);
await check('a decline passes the ride to the next driver straight away', async () => {
    assert.ok(await waitFor(() => eventsTo(far, 'rideRequest').length === 1), 'the next driver was not offered it');
});
await check('the second report of one decline does not pass it on twice', async () => {
    dispatch.markDriverRejectedFromDispatch(declined._id, near);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(eventsTo(far, 'rideRequest').length, 1);
});
dispatch.markDriverRejectedFromDispatch(declined._id, far);
await check('everyone declined: the ride closes now, not at five minutes', async () => {
    assert.ok(await waitFor(async () => (await Ride.findById(declined._id).lean())?.status !== 'searching'), 'still searching');
});
await check('and a driver who declined is never offered it again', async () => {
    assert.equal(eventsTo(near, 'rideRequest').length, 1);
    assert.equal(eventsTo(far, 'rideRequest').length, 1);
});

// A driver who simply did not answer does get another turn. A 1 s window here.
sent.length = 0;
await AdminBusinessSetting.collection.updateOne({ scope: 'default' }, { $set: { 'transport_ride.trip_accept_reject_duration_for_driver': '1' } });
const unanswered = await makeRide();
await dispatch.startDispatchFlow(unanswered);
await check('a driver who let the timer run out is offered it again', async () => {
    assert.ok(await waitFor(() => eventsTo(near, 'rideRequest').length >= 2), 'not offered again');
});
dispatch.stopDispatchFlow(unanswered._id);

await new Promise((r) => setTimeout(r, 300));
await mongoose.disconnect();
await replSet.stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
