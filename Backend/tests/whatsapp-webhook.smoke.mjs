/**
 * Meta WhatsApp webhook (core/whatsapp): verification, signatures, incoming
 * messages, receipts, and the admin inbox.
 *
 * Run: node tests/whatsapp-webhook.smoke.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const APP_SECRET = 'a'.repeat(32);
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
process.env.WHATSAPP_VERIFY_TOKEN = 'qd_test_verify_token';

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: 'whatsapp_webhook' });
const { default: whatsappWebhookRouter } = await import('../src/core/whatsapp/whatsappWebhook.routes.js');
const inbox = await import('../src/core/whatsapp/whatsappInbox.service.js');
const { WhatsAppMessage } = await import('../src/core/whatsapp/whatsappMessage.model.js');
const { ensureWhatsAppVerifyToken, whatsappCredentials } = await import('../src/core/settings/platformProfile.service.js');
await WhatsAppMessage.syncIndexes();

const app = express();
app.use('/api/v1/whatsapp/webhook', whatsappWebhookRouter());
app.use(express.json());
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/v1/whatsapp/webhook`;

let failures = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (err) { failures += 1; console.log(`  FAIL ${label}\n       ${err.stack?.split('\n').slice(0, 3).join(' | ')}`); }
};
const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const post = (obj, { signature, raw } = {}) => {
  const body = raw ?? JSON.stringify(obj);
  return fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(Buffer.from(body)) }, body });
};
const ts = () => String(Math.floor(Date.now() / 1000));
const envelope = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, ...value } }] }] });

await check('GET with the right verify token answers the challenge', async () => {
  const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=qd_test_verify_token&hub.challenge=98765`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '98765');
});
await check('GET with a wrong verify token is refused', async () => {
  const r = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=98765`);
  assert.equal(r.status, 403);
});
await check('POST with a bad or missing signature is refused and stores nothing', async () => {
  const body = envelope({ messages: [{ id: 'wamid.BAD', from: '919800000001', timestamp: ts(), type: 'text', text: { body: 'hi' } }] });
  assert.equal((await post(body, { signature: sign(Buffer.from('other'), APP_SECRET) })).status, 401);
  assert.equal((await post(body, { signature: '' })).status, 401);
  assert.equal((await post(body, { signature: sign(Buffer.from(JSON.stringify(body)), 'b'.repeat(32)) })).status, 401);
  assert.equal(await WhatsAppMessage.countDocuments({ wamid: 'wamid.BAD' }), 0);
});
await check('an incoming text is stored unescaped, with the sender name, once', async () => {
  const body = envelope({
    contacts: [{ wa_id: '919800000001', profile: { name: 'Asha' } }],
    messages: [{ id: 'wamid.IN1', from: '919800000001', timestamp: ts(), type: 'text', text: { body: 'Where is my order? <3' } }],
  });
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200, 'Meta redelivery');
  const rows = await WhatsAppMessage.find({ wamid: 'wamid.IN1' }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'Where is my order? <3');
  assert.equal(rows[0].contactName, 'Asha');
  assert.equal(rows[0].direction, 'in');
  assert.equal(rows[0].readByAdmin, false);
});
await check('receipts move forward only: sent, read, then a late delivered keeps read', async () => {
  await inbox.recordOutgoingWhatsApp({ wamid: 'wamid.OUT1', phone: '919800000001', payload: { type: 'text', text: { body: 'On the way' } }, sentBy: 'admin:x' });
  const st = (status) => envelope({ statuses: [{ id: 'wamid.OUT1', status, timestamp: ts(), recipient_id: '919800000001' }] });
  for (const s of ['sent', 'read', 'delivered']) assert.equal((await post(st(s))).status, 200);
  const row = await WhatsAppMessage.findOne({ wamid: 'wamid.OUT1' }).lean();
  assert.equal(row.status, 'read');
  assert.deepEqual(row.statusHistory.map((h) => h.status), ['sent', 'read', 'delivered']);
  assert.equal(row.text, 'On the way');
});
await check('a receipt that beats the send record is kept, and the send fills it in', async () => {
  await post(envelope({ statuses: [{ id: 'wamid.OUT2', status: 'delivered', timestamp: ts(), recipient_id: '919800000002' }] }));
  await inbox.recordOutgoingWhatsApp({ wamid: 'wamid.OUT2', phone: '919800000002', payload: { type: 'template', template: { name: 'food_invoice' } }, sentBy: 'food-invoice' });
  const row = await WhatsAppMessage.findOne({ wamid: 'wamid.OUT2' }).lean();
  assert.equal(row.status, 'delivered');
  assert.equal(row.text, 'Template: food_invoice');
  assert.equal(row.sentBy, 'food-invoice');
});
await check('a failed receipt records Meta\'s reason', async () => {
  await inbox.recordOutgoingWhatsApp({ wamid: 'wamid.OUT3', phone: '919800000003', payload: { type: 'text', text: { body: 'x' } } });
  await post(envelope({ statuses: [{ id: 'wamid.OUT3', status: 'failed', timestamp: ts(), recipient_id: '919800000003', errors: [{ code: 131047, title: 'Re-engagement message' }] }] }));
  const row = await WhatsAppMessage.findOne({ wamid: 'wamid.OUT3' }).lean();
  assert.equal(row.status, 'failed');
  assert.match(row.error, /131047 Re-engagement message/);
});
await check('inbox lists conversations with unread counts and the reply window; opening marks read', async () => {
  const list = await inbox.listConversations();
  const asha = list.find((c) => c.phone === '919800000001');
  assert.equal(asha.contactName, 'Asha');
  assert.equal(asha.unread, 1);
  assert.equal(asha.canReply, true);
  assert.equal(list.find((c) => c.phone === '919800000002').canReply, false, 'never wrote to us');
  const conv = await inbox.getConversation('+91 98000 00001');
  assert.equal(conv.messages.length, 2);
  assert.equal(await inbox.unreadCount(), 0);
});
await check('a reply with WhatsApp not set up says so instead of pretending', async () => {
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  await assert.rejects(inbox.replyToConversation('919800000001', 'hello'), /not set up/);
  await assert.rejects(inbox.replyToConversation('919800000001', '  '), /Type a message/);
});
await check('a verify token is made once when none is set, and kept', async () => {
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  await ensureWhatsAppVerifyToken();
  const first = whatsappCredentials().verifyToken;
  assert.match(first, /^qd_[a-f0-9]{40}$/);
  await ensureWhatsAppVerifyToken();
  assert.equal(whatsappCredentials().verifyToken, first);
});
await check('with no app secret anywhere, POSTs are refused with 503 (Meta retries later)', async () => {
  delete process.env.WHATSAPP_APP_SECRET;
  assert.equal((await post(envelope({}))).status, 503);
});

server.close();
await mongoose.disconnect();
await mongo.stop();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
