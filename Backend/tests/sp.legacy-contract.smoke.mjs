// Contract check for the SHIPPED mobile clients (Flutter customer app, seller APK).
//
// Those builds call the service-provider backend on its original top-level paths --
// /api/users/..., /api/vendors/..., /api/workers/... -- not the /api/v1/sp prefix the
// web admin uses. They cannot be updated in lockstep with the server, so those paths
// are a contract: every route must answer identically on both prefixes, and none may
// 404 or 5xx.
//
// Run: node tests/sp.legacy-contract.smoke.mjs

import assert from 'node:assert/strict';
import http from 'node:http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

const OID = '000000000000000000000001';

const collectPaths = (stack, prefix = '') => {
    const out = [];
    for (const layer of stack) {
        if (layer.route) {
            for (const m of Object.keys(layer.route.methods || {})) {
                if (m === 'get') out.push(prefix + layer.route.path);
            }
            continue;
        }
        if (layer.name === 'router' && layer.handle?.stack) {
            let mount = '';
            const src = layer.regexp?.source ?? '';
            if (src !== '^\\/?(?=\\/|$)') {
                mount = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\$$/, '').replace(/\\\//g, '/');
            }
            out.push(...collectPaths(layer.handle.stack, prefix + mount));
        }
    }
    return out;
};

let failures = 0;
const check = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.log(`  FAIL ${name}\n         ${err.message}`); }
};

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();
process.env.NODE_ENV = 'test';
await mongoose.connect(process.env.MONGO_URI);

const { default: app } = await import('../src/app.js');
const { default: spRouter } = await import('../src/modules/serviceProvider/routes/index.js');
const server = app.listen(0);
const port = server.address().port;

const get = (path) =>
    new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
    });

// The legacy top-level prefixes, exactly as src/routes/index.js delegates them.
const LEGACY = ['/users', '/user', '/vendors', '/workers', '/admin', '/bookings', '/payments', '/notifications', '/public', '/scrap', '/image'];

const paths = [...new Set(collectPaths(spRouter.stack))]
    .filter((p) => p && !p.includes('*'))
    .map((p) => p.replace(/:[A-Za-z0-9_]+/g, OID))
    .filter((p) => LEGACY.some((l) => p === l || p.startsWith(`${l}/`)))
    .sort();

console.log(`\n[1] every mobile-facing route answers on BOTH prefixes (${paths.length} routes)`);

const mismatched = [];
const serverErrors = [];
let identical = 0;

for (const p of paths) {
    const legacy = await get(`/api${p}`);
    const canonical = await get(`/api/v1/sp${p}`);

    if (legacy.status >= 500) serverErrors.push(`/api${p} -> ${legacy.status}`);
    if (legacy.status === 404) mismatched.push(`/api${p} -> 404 (route unreachable for mobile clients)`);
    else if (legacy.status !== canonical.status) mismatched.push(`/api${p} -> ${legacy.status} but /api/v1/sp${p} -> ${canonical.status}`);
    else identical++;
}

check(`${identical}/${paths.length} return the same status on both prefixes`, () =>
    assert.equal(mismatched.length, 0, `\n         ${mismatched.slice(0, 12).join('\n         ')}`));
check('no 5xx on any legacy path', () =>
    assert.equal(serverErrors.length, 0, `\n         ${serverErrors.slice(0, 8).join('\n         ')}`));
check('a meaningful number of routes were checked', () => assert.ok(paths.length > 40, `only ${paths.length}`));

console.log('\n[2] the customer journey a mobile app actually performs');

const post = (path, payload) =>
    new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request(
            { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); },
        );
        req.on('error', reject); req.write(body); req.end();
    });

// Static OTP so the journey is deterministic and sends no SMS.
process.env.ALLOW_TEST_OTP = 'true';
process.env.TEST_OTP_PHONE = '9000000123';
process.env.TEST_OTP_CODE = '123456';

const sent = await post('/api/users/auth/send-otp', { phone: '9000000123' });
check(`send-otp on the LEGACY path -> ${sent.status}`, () => assert.equal(sent.status, 200));

const verified = await post('/api/users/auth/verify-login', { phone: '9000000123', otp: '123456' });
let token = null;
try { token = JSON.parse(verified.body).accessToken; } catch { /* reported below */ }
check(`verify-login on the LEGACY path -> ${verified.status}`, () => assert.equal(verified.status, 200));
check('returns an accessToken the app can store', () => assert.ok(token, verified.body.slice(0, 160)));

const authed = (path) =>
    new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` } }, (res) => {
            let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }).on('error', reject);
    });

for (const p of ['/api/users/profile', '/api/public/categories', '/api/users/bookings']) {
    const r = await authed(p);
    check(`${p} accepts that token -> ${r.status}`, () => {
        assert.notEqual(r.status, 404);
        assert.notEqual(r.status, 401);
        assert.ok(r.status < 500, `got ${r.status}`);
    });
}

console.log('\n[3] response envelope is unchanged (mobile parsers are brittle)');
{
    const r = await get('/api/public/cities');
    let parsed = null;
    try { parsed = JSON.parse(r.body); } catch { /* below */ }
    check('legacy path returns JSON, not the SPA HTML', () => assert.ok(parsed, r.body.slice(0, 80)));
    check('keeps the { success: ... } envelope', () => assert.ok(parsed && 'success' in parsed));
}

server.close();
await mongoose.disconnect();
await mongod.stop();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
