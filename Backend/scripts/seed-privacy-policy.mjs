/**
 * Seed the platform-wide Privacy Policy (Master settings -> Legal pages) with the
 * full default policy (src/core/settings/defaultPrivacyPolicy.js), under this
 * site's own brand name.
 *
 *   node scripts/seed-privacy-policy.mjs           # dry run: prints what it would do
 *   node scripts/seed-privacy-policy.mjs --apply
 *
 * Writes only when the platform-wide policy is empty: a policy an admin already
 * wrote is never overwritten. Every app with no page of its own shows it; the
 * running API picks it up on its next settings refresh.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { defaultPrivacyPolicyHtml } from '../src/core/settings/defaultPrivacyPolicy.js';

const apply = process.argv.includes('--apply');
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) throw new Error('MONGO_URI is not set');

await mongoose.connect(uri);
const db = mongoose.connection.db;

const profile = await db.collection('platform_profile').findOne({ _id: 'platform' });
const existing = String(profile?.legal?.privacy || '').trim();
if (existing) {
  console.log(`Platform privacy policy already set (${existing.length} chars) -- leaving it alone.`);
  await mongoose.disconnect();
  process.exit(0);
}

const settings = (await db.collection('foodbusinesssettings').findOne({})) || (await db.collection('qc_business_settingses').findOne({})) || {};
const brand = String(profile?.brand?.name || settings.companyName || 'Quick Drop').trim();
const html = defaultPrivacyPolicyHtml({ brand });

console.log(`Brand: ${brand}\nPolicy: ${html.length} chars`);
if (!apply) {
  console.log('Dry run -- pass --apply to write.');
} else {
  await db.collection('platform_profile').updateOne(
    { _id: 'platform' },
    { $set: { 'legal.privacy': html, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  console.log('Written to platform_profile.legal.privacy.');
}
await mongoose.disconnect();
