/**
 * Cash limits per kind of rider (client, 2026-11-19): Rs 100 for bike taxi,
 * Rs 1500 for food delivery and for riders doing both.
 *
 * Run: node tests/bike-taxi-cash-limit.smoke.mjs
 */
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let failed = 0;
const check = async (label, fn) => {
    try { await fn(); console.log(`  PASS  ${label}`); }
    catch (err) { failed += 1; console.log(`  FAIL  ${label}\n        ${err.stack?.split('\n').slice(0, 2).join(' | ')}`); }
};

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'bike_taxi_cash_limit' });
const { set } = await import('../src/core/config/resolver.service.js');
const { resolveSharedCashLimit } = await import('../src/core/finance/riderFinance.service.js');
const { Driver } = await import('../src/modules/taxi/driver/models/Driver.js');

const driver = async (fields) => (await Driver.collection.insertOne({ name: 'R', phone: String(Math.random()).slice(2, 12), ...fields })).insertedId;
const bikeTaxi = await driver({ serviceCapabilities: ['taxi'], driverClass: 'two_wheeler', vehicleType: 'bike' });
const both = await driver({ serviceCapabilities: ['taxi', 'delivery', 'quickCommerce', 'parcel'], driverClass: 'two_wheeler', vehicleType: 'bike' });
const food = await driver({ serviceCapabilities: ['delivery', 'quickCommerce', 'parcel'], driverClass: 'two_wheeler', vehicleType: 'bike' });
const car = await driver({ serviceCapabilities: ['taxi'], driverClass: 'passenger_taxi', vehicleType: 'car' });
const oldBike = await driver({ serviceCapabilities: ['taxi'], vehicleType: 'bike' }); // signed up on the taxi side, no section
const limitOf = async (id) => (await resolveSharedCashLimit({ partnerId: String(id) })).cashLimit;

await set('finance.cashLimit', { level: 'global', scopeId: null, value: 1500 });

await check('before the bike-taxi limit is set, everyone has Rs 1500', async () => {
    assert.equal(await limitOf(bikeTaxi), 1500);
});

await set('finance.cashLimitBikeTaxi', { level: 'global', scopeId: null, value: 100 });
await check('a bike-taxi rider gets Rs 100', async () => assert.equal(await limitOf(bikeTaxi), 100));
await check('a bike-taxi rider signed up on the taxi side (bike, no section) too', async () => assert.equal(await limitOf(oldBike), 100));
await check('a rider doing both keeps Rs 1500', async () => assert.equal(await limitOf(both), 1500));
await check('a food delivery rider keeps Rs 1500', async () => assert.equal(await limitOf(food), 1500));
await check('a car taxi driver keeps Rs 1500', async () => assert.equal(await limitOf(car), 1500));
await check('the source says why', async () => {
    const r = await resolveSharedCashLimit({ partnerId: String(bikeTaxi) });
    assert.match(r.cashLimitSource, /Bike-taxi/);
});
await check('a limit set for that rider personally still wins', async () => {
    await set('finance.cashLimit', { level: 'partner', scopeId: String(bikeTaxi), value: 300 });
    assert.equal(await limitOf(bikeTaxi), 300);
});

await mongoose.disconnect();
await mongo.stop();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
