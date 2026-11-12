/**
 * A throwaway local backend for checking what a sub-admin sees.
 *
 * Starts an in-memory MongoDB (never the .env database), seeds an owner, two
 * taxi service locations and a taxi-only sub-admin, prints a sign-in token for
 * each, then starts the API on PORT (default 5099) against that database.
 *
 * Run: node scripts/local-subadmin-sandbox.mjs
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('sandbox');
process.env.MONGO_URI = process.env.MONGODB_URI;
process.env.REDIS_ENABLED = 'false';
process.env.PORT = process.env.PORT || '5099';
process.env.NODE_ENV = 'development';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGODB_URI);
const { FoodAdmin } = await import('../src/core/admin/admin.model.js');
const { ServiceLocation } = await import('../src/modules/taxi/admin/models/ServiceLocation.js');
const { signAccessToken } = await import('../src/core/auth/token.util.js');
const svc = await import('../src/core/admin/platformAdmins.service.js');

const owner = await FoodAdmin.create({
  name: 'Sandbox Owner', email: 'owner@sandbox.test', phone: '9000000000', password: 'sandbox-owner',
  role: 'ADMIN', admin_type: 'superadmin', adminLevel: 'platform_superadmin',
  servicesAccess: ['food', 'quickCommerce', 'medical', 'taxi', 'serviceProvider'], permissions: ['*'],
});
const locs = await ServiceLocation.collection.insertMany([
  { name: 'Siliguri', service_location_name: 'Siliguri', active: true },
  { name: 'Kolkata', service_location_name: 'Kolkata', active: true },
]);
const siliguri = String(locs.insertedIds[0]);

const created = await svc.createAdmin(owner.toObject(), {
  name: 'Taxi Only', email: 'taxi@sandbox.test', phone: '9000000002', role: 'custom',
  servicesAccess: ['taxi'], permissions: ['dashboard.read', 'orders.read', 'delivery.read'],
  serviceLocationIds: [siliguri], password: 'sandbox-taxi',
});
await mongoose.disconnect();

const tok = (id) => signAccessToken({ userId: String(id), role: 'ADMIN' });
console.log('SANDBOX_OWNER_TOKEN=' + tok(owner._id));
console.log('SANDBOX_TAXI_TOKEN=' + tok(created.id));
console.log('SANDBOX_SUBADMIN=' + JSON.stringify(created));

await import('../server.js');
