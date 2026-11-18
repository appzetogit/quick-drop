/**
 * A quick-commerce store registering its phone or browser for pushes through
 * the shared /fcm-tokens endpoint lands on its quick-commerce account.
 *
 * Run: node tests/fcm-qc-store.smoke.mjs
 */
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'fcm_qc_store' });
const { signAccessToken } = await import('../src/core/auth/token.util.js');
const { default: fcmRoutes } = await import('../src/core/notifications/fcm.routes.js');
const { FoodRestaurant: QcStore } = await import('../src/modules/quickCommerce/modules/food/restaurant/models/restaurant.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
assert.notEqual(QcStore.collection.name, FoodRestaurant.collection.name, 'separate collections');

const app = express();
app.use(express.json());
app.use('/fcm-tokens', fcmRoutes);
app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ message: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/fcm-tokens`;

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.stack?.split('\n').slice(0, 3).join(' | ')}`); }
};
const post = (path, auth, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });

const storeId = new mongoose.Types.ObjectId();
await QcStore.collection.insertOne({ _id: storeId, restaurantName: 'Fresh Mart', status: 'approved' });
const storeToken = signAccessToken({ userId: String(storeId), role: 'RESTAURANT' });
const foodId = new mongoose.Types.ObjectId();
await FoodRestaurant.collection.insertOne({ _id: foodId, restaurantName: 'Sharma Dhaba', status: 'approved' });
const foodToken = signAccessToken({ userId: String(foodId), role: 'RESTAURANT' });
const webFcm = `web-${'x'.repeat(40)}`;
const appFcm = `app-${'y'.repeat(40)}`;

await check('a quick-commerce store saves its browser token (was 401 "Session is stale")', async () => {
  const r = await post('/save', storeToken, { token: webFcm, platform: 'web' });
  assert.equal(r.status, 200, await r.text());
  const doc = await QcStore.collection.findOne({ _id: storeId });
  assert.ok(JSON.stringify(doc).includes(webFcm));
});
await check('a quick-commerce store saves its phone token', async () => {
  const r = await post('/mobile/save', storeToken, { token: appFcm });
  assert.equal(r.status, 200, await r.text());
  const doc = await QcStore.collection.findOne({ _id: storeId });
  assert.ok(JSON.stringify(doc).includes(appFcm));
});
await check('a food restaurant still saves to food, not quick commerce', async () => {
  const t = `food-${'z'.repeat(40)}`;
  const r = await post('/save', foodToken, { token: t, platform: 'web' });
  assert.equal(r.status, 200, await r.text());
  assert.ok(JSON.stringify(await FoodRestaurant.collection.findOne({ _id: foodId })).includes(t));
});
await check('an account that exists nowhere is still refused', async () => {
  const ghost = signAccessToken({ userId: String(new mongoose.Types.ObjectId()), role: 'RESTAURANT' });
  const r = await post('/save', ghost, { token: `g-${'q'.repeat(40)}`, platform: 'web' });
  assert.equal(r.status, 401);
});

server.close();
await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
