/**
 * Sliding sessions (core/auth/refreshRenewal.js): a refresh token in the second
 * half of its life is replaced, so an active login never hits day 30.
 *
 * Run: node tests/refresh-renewal.smoke.mjs
 */
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.JWT_REFRESH_EXPIRES = '30d';
const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'refresh_renewal' });
const { config } = await import('../src/config/env.js');
const { refreshAccessToken } = await import('../src/core/auth/auth.service.js');
const { FoodRefreshToken } = await import('../src/core/refreshTokens/refreshToken.model.js');

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.stack?.split('\n').slice(0, 3).join(' | ')}`); }
};
const DAY = 24 * 3600 * 1000;
const userId = new mongoose.Types.ObjectId();
/** A stored refresh token issued `ageDays` ago (30-day life). */
async function issued(ageDays) {
  const iat = Math.floor((Date.now() - ageDays * DAY) / 1000);
  const token = jwt.sign({ userId: String(userId), role: 'ADMIN', iat, exp: iat + 30 * 24 * 3600 }, config.jwtRefreshSecret);
  await FoodRefreshToken.create({ userId, token, expiresAt: new Date((iat + 30 * 24 * 3600) * 1000) });
  return token;
}

await check('a young token (5 days old) is returned as it is', async () => {
  const token = await issued(5);
  const r = await refreshAccessToken(token);
  assert.equal(r.refreshToken, token);
  assert.ok(r.accessToken);
});
await check('an ageing token (20 days old) is replaced by one good for 30 more days', async () => {
  const token = await issued(20);
  const r = await refreshAccessToken(token);
  assert.notEqual(r.refreshToken, token);
  const fresh = jwt.verify(r.refreshToken, config.jwtRefreshSecret);
  assert.equal(fresh.userId, String(userId));
  assert.equal(fresh.role, 'ADMIN');
  assert.ok(fresh.exp * 1000 - Date.now() > 29 * DAY);
  assert.ok(await FoodRefreshToken.exists({ token: r.refreshToken }));
});
await check('the replaced token keeps working for a short grace period only', async () => {
  const token = await issued(25);
  const r = await refreshAccessToken(token);
  const old = await FoodRefreshToken.findOne({ token }).lean();
  assert.ok(old, 'still stored');
  assert.ok(old.expiresAt.getTime() - Date.now() <= 2 * DAY + 1000);
  const again = await refreshAccessToken(token);
  assert.ok(again.accessToken, 'a lost reply can be retried with the old token');
  assert.ok((await refreshAccessToken(r.refreshToken)).accessToken, 'the new token works');
});
await check('an unknown token is still refused', async () => {
  const token = jwt.sign({ userId: String(userId), role: 'ADMIN' }, config.jwtRefreshSecret, { expiresIn: '1d' });
  await assert.rejects(refreshAccessToken(token), /Invalid refresh token/);
});

await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
