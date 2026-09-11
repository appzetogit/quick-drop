/**
 * A ride is charged from its vehicle's price -- never from a figure the app sent
 * -- and the quote the app shows is that same price.
 *
 * Run: node tests/taxi-fare-quote.smoke.mjs
 *
 * From production, 8-10 Sep: a second "Bike" was added with no price row. The
 * app, finding none, priced it at the first row it had -- the Sedan's -- and the
 * server, finding none either, charged whatever the app sent. A 3.3 km bike
 * ride was billed Rs 113; as a bike it is Rs 45.
 *
 * Drives the real rideService against an in-memory Mongo.
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

const main = async () => {
    const mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'taxi_fare' });

    const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
    const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
    const { User } = await import('../src/modules/taxi/user/models/User.js');
    const svc = await import('../src/modules/taxi/services/rideService.js');

    const id = () => new mongoose.Types.ObjectId();
    const oldBike = id(), sedan = id(), newBike = id(), scooter = id();
    const vehicle = (_id, name, createdAt) => ({ _id, name, createdAt: new Date(createdAt), active: true, status: 1, transport_type: 'taxi' });
    await Vehicle.collection.insertMany([
        vehicle(oldBike, 'Bike', '2026-08-26'),
        vehicle(sedan, 'Sedan', '2026-08-26'),
        vehicle(newBike, 'Bike', '2026-09-05'),   // never given a price
        vehicle(scooter, 'Scooter', '2026-09-06'), // never given a price, no namesake
    ]);

    const serviceLocation = id();
    const row = (vehicleType, prices) => ({
        vehicle_type: vehicleType, transport_type: 'taxi', pricing_scope: 'ride', active: 1, status: 'active',
        zone_id: null, service_location_id: serviceLocation, service_tax: 5,
        createdAt: new Date(), updatedAt: new Date(), ...prices,
    });
    // The production Bike and Sedan rows.
    await SetPrice.collection.insertMany([
        row(oldBike, { base_price: 20, base_distance: 2, price_per_distance: 8, time_price: 1, admin_commision: 5, admin_commision_type: 0 }),
        row(sedan, { base_price: 70, base_distance: 2, price_per_distance: 17, time_price: 2, admin_commision: 5, admin_commision_type: 1 }),
    ]);

    // The 3.27 km trip from the bill.
    const trip = { estimatedDistanceMeters: 3265.5576841561756, estimatedDurationMinutes: 7.837338441974822 };
    const pickup = [75.8843529, 22.7282245];
    const drop = [75.9143529, 22.7282245];

    console.log('\nwhich price a vehicle is charged from');
    await check('a vehicle with no price borrows its older namesake\'s', async () => {
        const rule = await svc.resolveSetPriceForRide({ transportType: 'taxi', vehicleTypeId: newBike });
        assert.ok(rule, 'no rule found');
        assert.equal(String(rule.vehicle_type), String(oldBike));
        assert.equal(String(rule.borrowedFromVehicleTypeId), String(oldBike));
    });
    await check('a vehicle with its own price keeps it', async () => {
        const rule = await svc.resolveSetPriceForRide({ transportType: 'taxi', vehicleTypeId: sedan });
        assert.equal(String(rule.vehicle_type), String(sedan));
        assert.equal(rule.borrowedFromVehicleTypeId, undefined);
    });
    await check('a vehicle with no price and no namesake has none', async () => {
        assert.equal(await svc.resolveSetPriceForRide({ transportType: 'taxi', vehicleTypeId: scooter }), null);
    });

    console.log('\nthe quote the booking screen shows');
    const quotes = await svc.quoteRideFares({ pickupCoords: pickup, ...trip, vehicleTypeIds: [newBike, sedan, scooter], transport_type: 'taxi' });
    const quoteFor = (v) => quotes.find((q) => q.vehicleTypeId === String(v));
    await check('THE BUG: the new Bike is quoted at bike rates, Rs 45 -- not Sedan\'s Rs 113', async () => {
        assert.equal(quoteFor(newBike).fare.total, 45);
    });
    await check('the Sedan is quoted at its own rates', async () => {
        assert.equal(quoteFor(sedan).fare.total, 118);
    });
    await check('a vehicle that cannot be priced is quoted as unavailable', async () => {
        assert.equal(quoteFor(scooter).available, false);
        assert.equal(quoteFor(scooter).fare, null);
    });
    await check('the quote\'s rows add up to its total', async () => {
        const f = quoteFor(newBike).fare;
        const rows = f.baseFare + f.distanceFare + f.timeFare + f.serviceTax + f.platformFee + f.roundOff + f.surge;
        assert.equal(Math.round(rows * 100) / 100, f.total);
    });

    console.log('\nthe tariff list older apps read');
    await check('lists the new Bike under its own id, at bike rates', async () => {
        const rows = await svc.addBorrowedRidePriceRows([
            { id: 'a', type_id: String(oldBike), pricing_scope: 'ride', base_price: 20 },
            { id: 'b', type_id: String(sedan), pricing_scope: 'ride', base_price: 70 },
        ]);
        const mine = rows.filter((r) => r.type_id === String(newBike));
        assert.equal(mine.length, 1, 'no row for the new Bike');
        assert.equal(mine[0].base_price, 20);
        assert.ok(!rows.some((r) => r.type_id === String(scooter)), 'invented a row for the Scooter');
    });

    console.log('\nthe booking itself');
    const userId = id();
    await User.collection.insertOne({ _id: userId, name: 'Test Rider', phone: '9999999999', createdAt: new Date() });
    const book = (vehicleTypeId, fare) => svc.createRideRecord({
        userId, pickupCoords: pickup, dropCoords: drop, pickupAddress: 'A', dropAddress: 'B',
        fare, ...trip, vehicleTypeId, paymentMethod: 'cash', serviceType: 'ride', transport_type: 'taxi',
    });
    await check('THE BUG: a new-Bike ride sent at Rs 113 is charged Rs 45', async () => {
        const ride = await book(newBike, 113);
        assert.equal(Number(ride.fare), 45, `charged ${ride.fare}`);
        await mongoose.connection.collection('taxirides').deleteMany({});
        await User.collection.updateOne({ _id: userId }, { $set: { currentRideId: null } });
    });
    await check('a ride sent at Rs 0 is still charged its price', async () => {
        const ride = await book(sedan, 0);
        assert.equal(Number(ride.fare), 118, `charged ${ride.fare}`);
        await mongoose.connection.collection('taxirides').deleteMany({});
        await User.collection.updateOne({ _id: userId }, { $set: { currentRideId: null } });
    });
    await check('a vehicle nobody priced cannot be booked at the app\'s figure', async () => {
        await assert.rejects(() => book(scooter, 50), (err) => err.statusCode === 400 || err.status === 400);
    });

    await mongoose.disconnect();
    await mongo.stop();

    console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
    process.exit(failed ? 1 : 0);
};

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
