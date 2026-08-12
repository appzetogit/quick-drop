/**
 * Service-Provider data migration: Truliq cluster -> master (K9) cluster.
 *
 * The two projects live on SEPARATE Atlas clusters, so this is a cross-cluster copy
 * with a rename, not an in-place `renameCollection`.
 *
 *   source  <SP_SOURCE_MONGO_URI>  e.g. cluster0.../Truliq
 *   target  <MONGO_URI>            e.g. k9.../K9
 *
 * SAFETY
 *   - Dry run by DEFAULT. Nothing is written without --apply.
 *   - Never drops, never renames, never deletes anything on either side.
 *   - Idempotent: documents are upserted by _id, so re-running converges.
 *   - Refuses to touch a non-empty target collection unless --force, so a second
 *     run cannot quietly clobber data written since the first.
 *   - Reads only from the source. The source cluster is never modified.
 *
 * USAGE
 *   node scripts/sp-migrate-data.js                      # dry run, full report
 *   node scripts/sp-migrate-data.js --apply              # perform the copy
 *   node scripts/sp-migrate-data.js --apply --only=vendors,workers
 *   node scripts/sp-migrate-data.js --verify             # compare counts after
 *
 * ADMINS are special: they merge into master's shared `admins` collection (which
 * FoodAdmin and TaxiAdmin already use) and are stamped with
 * servicesAccess: ['serviceProvider']. An email that already exists on the target is
 * REPORTED AND SKIPPED, never overwritten -- that is someone's live login.
 */

import mongoose from 'mongoose';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const VERIFY = args.includes('--verify');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').replace('--only=', '').split(',').filter(Boolean);
const BATCH = 500;

const SOURCE_URI = process.env.SP_SOURCE_MONGO_URI;
const TARGET_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const TARGET_DB = process.env.MONGODB_DB_NAME || undefined;

/**
 * source collection (mongoose-pluralised from the old model name) -> target collection.
 * Kept explicit rather than derived, so a rename here is a deliberate edit.
 */
const COLLECTION_MAP = {
  admins: 'admins', // MERGE into the shared collection -- see mergeAdmins()
  users: 'sp_users',
  bookings: 'sp_bookings',
  bookingrequests: 'sp_booking_requests',
  brands: 'sp_brands',
  carts: 'sp_carts',
  categories: 'sp_categories',
  cities: 'sp_cities',
  homecontents: 'sp_home_contents',
  notifications: 'sp_notifications',
  notificationlogs: 'sp_notification_logs',
  plans: 'sp_plans',
  platformearnings: 'sp_platform_earnings',
  reviews: 'sp_reviews',
  scraps: 'sp_scraps',
  services: 'sp_services',
  settings: 'sp_settings',
  settlements: 'sp_settlements',
  tokens: 'sp_tokens',
  transactions: 'sp_transactions',
  userservices: 'sp_user_services',
  vendors: 'sp_vendors',
  vendorbills: 'sp_vendor_bills',
  vendorpartscatalogs: 'sp_vendor_parts_catalogs',
  vendorservices: 'sp_vendor_services',
  vendorservicecatalogs: 'sp_vendor_service_catalogs',
  withdrawals: 'sp_withdrawals',
  workers: 'sp_workers',
  workersubscriptionplans: 'sp_worker_subscription_plans',
};

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(7);

async function connect(uri, dbName) {
  const conn = await mongoose.createConnection(uri, dbName ? { dbName } : {}).asPromise();
  return conn;
}

async function copyCollection(srcDb, tgtDb, from, to) {
  const srcCol = srcDb.collection(from);
  const tgtCol = tgtDb.collection(to);

  const srcCount = await srcCol.countDocuments();
  const tgtCountBefore = await tgtCol.countDocuments();

  if (srcCount === 0) {
    return { from, to, srcCount, tgtCountBefore, copied: 0, status: 'source empty, skipped' };
  }
  if (tgtCountBefore > 0 && !FORCE) {
    return {
      from, to, srcCount, tgtCountBefore, copied: 0,
      status: `target has ${tgtCountBefore} docs -- skipped (use --force to upsert into it)`,
    };
  }
  if (!APPLY) {
    return { from, to, srcCount, tgtCountBefore, copied: 0, status: 'DRY RUN would copy' };
  }

  let copied = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await tgtCol.bulkWrite(batch, { ordered: false });
    copied += batch.length;
    batch = [];
  };

  const cursor = srcCol.find({});
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    batch.push({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } });
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  return { from, to, srcCount, tgtCountBefore, copied, status: 'copied' };
}

/**
 * Admins merge into a live shared collection, so this is deliberately conservative:
 * insert only, never update, and report every collision instead of resolving it.
 */
async function mergeAdmins(srcDb, tgtDb) {
  const src = srcDb.collection('admins');
  const tgt = tgtDb.collection('admins');

  const spAdmins = await src.find({}).toArray();
  const collisions = [];
  const toInsert = [];

  for (const admin of spAdmins) {
    const email = String(admin.email || '').trim().toLowerCase();
    if (!email) {
      collisions.push({ email: '(missing)', reason: 'source admin has no email -- skipped' });
      continue;
    }
    const existing = await tgt.findOne({ email });
    if (existing) {
      const access = Array.isArray(existing.servicesAccess) ? existing.servicesAccess : [];
      collisions.push({
        email,
        reason: access.includes('serviceProvider')
          ? 'already exists WITH serviceProvider access -- nothing to do'
          : `already exists on target (servicesAccess: [${access.join(', ') || 'none'}]) -- NOT modified, grant access manually`,
      });
      continue;
    }
    toInsert.push({
      ...admin,
      email,
      servicesAccess: ['serviceProvider'],
      adminLevel: 'sp_superadmin',
      admin_type: admin.role === 'super_admin' ? 'superadmin' : 'subadmin',
      isActive: admin.isActive !== false,
    });
  }

  if (APPLY && toInsert.length) {
    await tgt.bulkWrite(
      toInsert.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
      { ordered: false },
    );
  }

  return { total: spAdmins.length, inserted: toInsert.length, collisions };
}

/** Phone overlap between SP users and the shared `users` collection. Report only. */
async function reportUserOverlap(srcDb, tgtDb) {
  const normalise = (p) => String(p || '').replace(/\D/g, '').slice(-10);
  const spPhones = new Set(
    (await srcDb.collection('users').find({}, { projection: { phone: 1 } }).toArray())
      .map((u) => normalise(u.phone)).filter((p) => p.length === 10),
  );
  if (spPhones.size === 0) return { spUsers: 0, masterUsers: 0, overlap: 0 };

  const masterPhones = (await tgtDb.collection('users').find({}, { projection: { phone: 1 } }).toArray())
    .map((u) => normalise(u.phone)).filter((p) => p.length === 10);

  let overlap = 0;
  for (const p of new Set(masterPhones)) if (spPhones.has(p)) overlap++;
  return { spUsers: spPhones.size, masterUsers: new Set(masterPhones).size, overlap };
}

async function main() {
  if (!SOURCE_URI) {
    console.error('\nSP_SOURCE_MONGO_URI is not set.\n');
    console.error('Set it to the Service-Provider (Truliq) connection string, e.g.\n');
    console.error('  SP_SOURCE_MONGO_URI="mongodb+srv://...:.../Truliq" node scripts/sp-migrate-data.js\n');
    process.exit(1);
  }
  if (!TARGET_URI) {
    console.error('\nMONGO_URI / MONGODB_URI is not set (target cluster).\n');
    process.exit(1);
  }

  console.log(`\nmode: ${VERIFY ? 'VERIFY' : APPLY ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}${FORCE ? ' +FORCE' : ''}`);

  const srcConn = await connect(SOURCE_URI);
  const tgtConn = await connect(TARGET_URI, TARGET_DB);
  const srcDb = srcConn.db;
  const tgtDb = tgtConn.db;

  console.log(`source db: ${srcDb.databaseName}`);
  console.log(`target db: ${tgtDb.databaseName}\n`);

  // --- nothing-left-behind check: every source collection must be accounted for ---
  const actual = (await srcDb.listCollections().toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
  const unmapped = actual.filter((n) => !COLLECTION_MAP[n]);
  const missing = Object.keys(COLLECTION_MAP).filter((n) => !actual.includes(n));

  console.log(`source has ${actual.length} collections; map covers ${Object.keys(COLLECTION_MAP).length}`);
  if (unmapped.length) {
    console.log(`\n  !! ${unmapped.length} SOURCE COLLECTION(S) NOT IN THE MAP -- these would be left behind:`);
    for (const n of unmapped) console.log(`     ${pad(n, 34)} ${await srcDb.collection(n).countDocuments()} docs`);
  }
  if (missing.length) console.log(`\n  (mapped but absent from source, harmless: ${missing.join(', ')})`);

  if (VERIFY) {
    console.log('\n--- VERIFY: source vs target counts ---');
    console.log(`  ${pad('source', 30)}${pad('target', 32)}${num('src')} ${num('tgt')}  match`);
    let bad = 0;
    for (const [from, to] of Object.entries(COLLECTION_MAP)) {
      if (!actual.includes(from)) continue;
      const s = await srcDb.collection(from).countDocuments();
      const t = await tgtDb.collection(to).countDocuments();
      // >= not ==: the target may legitimately hold more (admins already there,
      // or docs created after the copy).
      const ok = t >= s;
      if (!ok) bad++;
      console.log(`  ${pad(from, 30)}${pad(to, 32)}${num(s)} ${num(t)}  ${ok ? 'ok' : 'MISMATCH'}`);
    }
    console.log(`\n${bad === 0 ? 'VERIFY PASS' : `VERIFY FAIL -- ${bad} collection(s) short`}\n`);
    await srcConn.close(); await tgtConn.close();
    process.exit(bad === 0 ? 0 : 1);
  }

  // --- admins (merge, insert-only) ---
  console.log('\n--- admins (merge into the shared collection) ---');
  if (actual.includes('admins') && (!ONLY.length || ONLY.includes('admins'))) {
    const r = await mergeAdmins(srcDb, tgtDb);
    console.log(`  source admins       : ${r.total}`);
    console.log(`  ${APPLY ? 'inserted' : 'would insert'}     : ${r.inserted}  (stamped servicesAccess:['serviceProvider'], adminLevel:'sp_superadmin')`);
    console.log(`  collisions (skipped): ${r.collisions.length}`);
    for (const c of r.collisions) console.log(`     ${pad(c.email, 38)} ${c.reason}`);
  } else {
    console.log('  skipped');
  }

  // --- everything else ---
  console.log('\n--- collections ---');
  console.log(`  ${pad('source', 30)}${pad('-> target', 32)}${num('docs')}  status`);
  const results = [];
  for (const [from, to] of Object.entries(COLLECTION_MAP)) {
    if (from === 'admins') continue;
    if (!actual.includes(from)) continue;
    if (ONLY.length && !ONLY.includes(from)) continue;
    const r = await copyCollection(srcDb, tgtDb, from, to);
    results.push(r);
    console.log(`  ${pad(r.from, 30)}${pad('-> ' + r.to, 32)}${num(r.srcCount)}  ${r.status}`);
  }

  // --- identity overlap, informational (drives the later user merge) ---
  if (actual.includes('users')) {
    console.log('\n--- identity overlap (informational, nothing is merged) ---');
    const o = await reportUserOverlap(srcDb, tgtDb);
    console.log(`  SP users with a usable phone     : ${o.spUsers}`);
    console.log(`  master users with a usable phone : ${o.masterUsers}`);
    console.log(`  same phone on both sides         : ${o.overlap}`);
    console.log('  -> these are the accounts the later users-collection merge would link.');
  }

  const totalDocs = results.reduce((a, r) => a + r.srcCount, 0);
  const totalCopied = results.reduce((a, r) => a + r.copied, 0);
  console.log(`\n${APPLY ? `copied ${totalCopied} of ${totalDocs} documents` : `DRY RUN -- ${totalDocs} documents would be copied. Re-run with --apply.`}`);
  if (unmapped.length) console.log(`WARNING: ${unmapped.length} source collection(s) are unmapped and were NOT copied.`);
  console.log('');

  await srcConn.close();
  await tgtConn.close();
}

main().catch((err) => {
  console.error('\nMIGRATION ERROR:', err.message);
  process.exit(1);
});
