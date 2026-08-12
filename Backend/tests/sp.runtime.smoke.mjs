// Phase 4/5/6 exit criterion: boots the REAL server.js (not just app.js) against an
// in-memory MongoDB and proves the two things Phase 1 deliberately left switched off
// are now actually running -- the /sp socket namespace and the booking scheduler --
// without disturbing master's own io.
//
// Run: node tests/sp.runtime.smoke.mjs

import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';

let failures = 0;
const check = (name, fn) => {
    try {
        fn();
        console.log(`  ok   ${name}`);
    } catch (err) {
        failures++;
        console.log(`  FAIL ${name}\n         ${err.message}`);
    }
};

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri();
process.env.MONGODB_URI = mongod.getUri();
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

// server.js calls startServer() on import and never resolves a handle, so give it a
// moment to finish binding, then interrogate the live singletons it wired up.
await import('../server.js');
await new Promise((r) => setTimeout(r, 4000));

const { getIO } = await import('../src/config/socket.js');
const { tryGetIO } = await import('../src/modules/serviceProvider/sockets/index.js');
const { getScheduler } = await import('../src/modules/serviceProvider/services/bookingScheduler.js');
const { isOriginAllowed } = await import('../src/config/env.js');

console.log('\n[1] sockets');

const rootIo = getIO();
check('master root io exists', () => assert.ok(rootIo));

const spNs = tryGetIO();
check('SP namespace was attached', () => assert.ok(spNs, 'configureSPSocketServer never ran'));
check("SP namespace path is '/sp'", () => assert.equal(spNs.name, '/sp'));
check('SP is a namespace of master io, not a second server', () =>
    assert.equal(rootIo._nsps.get('/sp'), spNs));
check('master default namespace is untouched', () => assert.ok(rootIo._nsps.get('/')));

check('SP namespace exposes .adapter (the notificationController path)', () =>
    assert.ok(spNs.adapter && spNs.adapter.rooms instanceof Map));

check('SP namespace has an auth middleware registered', () =>
    assert.ok(spNs._fns.length > 0, 'no ns.use() handler -- sockets would be unauthenticated'));

console.log('\n[2] booking scheduler');

const scheduler = getScheduler();
check('scheduler instance was created', () => assert.ok(scheduler, 'initializeScheduler never ran'));
check('scheduler is running', () => assert.equal(scheduler.isRunning, true));
check('scheduler holds a timer handle', () => assert.ok(scheduler.intervalId));
check('scheduler got the SP namespace as its io', () => assert.equal(scheduler.io, spNs));

console.log('\n[3] CORS — SP front-ends can still reach this backend');

for (const origin of ['https://homster.in', 'https://www.homster.in', 'https://truliq.com', 'https://www.truliq.com']) {
    check(`${origin} allowed`, () => assert.equal(isOriginAllowed(origin), true));
}
check('an unrelated origin is still rejected', () =>
    assert.equal(isOriginAllowed('https://evil.example.com'), false));

console.log('\n[4] shutdown');

check('scheduler.stop() clears the timer', () => {
    scheduler.stop();
    assert.equal(scheduler.isRunning, false);
});

await mongod.stop();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
