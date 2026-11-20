/**
 * WhatsApp campaigns: pick an approved template, fill its variables, choose
 * customers, send.
 *
 * Starting a campaign snapshots its recipients (one row each). A ticker in the
 * API process then sends a few per second, claiming each row atomically so a
 * row is never sent twice. Opted-out customers are skipped at snapshot and
 * again at send time. Meta caps how many customers a number may start
 * conversations with in 24 hours (250 on this number's tier); when that is
 * reached the campaign pauses and carries on by itself as the window frees.
 */
import mongoose from 'mongoose';
import { WhatsAppCampaign, WhatsAppCampaignRecipient, WhatsAppContact } from './whatsappMarketing.models.js';
import { WhatsAppMessage } from './whatsappMessage.model.js';
import { normalizePhone, optedOutAmong, optedInAmong } from './whatsappContacts.service.js';
import { buildTemplatePayload, findTemplate, phoneInfo } from './whatsappMeta.service.js';
import { logger } from '../../utils/logger.js';

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const oid = (v) => (mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------ audience -- */

/**
 * audience = {
 *   type: 'all' | 'ordered' | 'not_ordered' | 'joined' | 'phones',
 *   days: 30,                 // for ordered / joined
 *   city: 'Palampur',         // optional, any saved address
 *   phones: '98..., 91...',   // for type 'phones'
 *   onlyOptedIn: false,       // true: only customers who said yes
 * }
 */
export async function resolveAudience(audience = {}) {
  const type = String(audience.type || 'all');
  const days = Math.min(Math.max(Number(audience.days) || 30, 1), 3650);
  const since = new Date(Date.now() - days * 86400000);
  let people = [];

  if (type === 'phones') {
    const list = String(audience.phones || '').split(/[\s,;]+/).map(normalizePhone).filter(Boolean);
    people = [...new Set(list)].map((phone) => ({ phone, name: '' }));
    if (!people.length) throw bad('Paste at least one valid phone number');
  } else {
    const { FoodUser } = await import('../users/user.model.js');
    const filter = { phone: { $nin: [null, ''] }, isActive: { $ne: false }, active: { $ne: false } };
    if (audience.city) filter['addresses.city'] = { $regex: `^${escapeRx(String(audience.city).trim())}$`, $options: 'i' };
    if (type === 'joined') filter.createdAt = { $gte: since };
    if (type === 'ordered' || type === 'not_ordered') {
      const orders = mongoose.connection.db.collection('food_orders');
      const qcOrders = mongoose.connection.db.collection('qc_orders');
      const match = type === 'ordered' ? { createdAt: { $gte: since } } : {};
      const [a, b] = await Promise.all([orders.distinct('userId', match), qcOrders.distinct('userId', match).catch(() => [])]);
      const ids = [...a, ...b].map(oid).filter(Boolean);
      filter._id = type === 'ordered' ? { $in: ids } : { $nin: ids };
    }
    const users = await FoodUser.find(filter).select('phone countryCode name').limit(20000).lean();
    const seen = new Set();
    for (const u of users) {
      const cc = String(u.countryCode || '').replace(/\D/g, '');
      const phone = normalizePhone(cc && String(u.phone).replace(/\D/g, '').length === 10 ? `${cc}${String(u.phone).replace(/\D/g, '')}` : u.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      people.push({ phone, name: String(u.name || '').trim() });
    }
  }

  const phones = people.map((p) => p.phone);
  const out = await optedOutAmong(phones);
  let kept = people.filter((p) => !out.has(p.phone));
  if (audience.onlyOptedIn) {
    const yes = await optedInAmong(phones);
    kept = kept.filter((p) => yes.has(p.phone));
  }
  return { people: kept, skippedOptedOut: people.length - people.filter((p) => !out.has(p.phone)).length };
}

export async function previewAudience(audience) {
  const { people, skippedOptedOut } = await resolveAudience(audience);
  return { count: people.length, skippedOptedOut, sample: people.slice(0, 5) };
}

/* ----------------------------------------------------------- campaigns -- */

const cleanVars = (v = {}) => ({
  header: v.header && typeof v.header === 'object' ? v.header : {},
  body: v.body && typeof v.body === 'object' ? v.body : {},
  buttons: v.buttons && typeof v.buttons === 'object' ? v.buttons : {},
});

async function templateFor(input) {
  const t = await findTemplate(String(input.templateName || ''), String(input.language || ''));
  if (!t) throw bad('Choose an approved template');
  if (t.status !== 'APPROVED') throw bad(`Template "${t.name}" is ${String(t.status).toLowerCase()}, not approved yet`);
  return t;
}

const mediaFrom = (m = {}, t) => ({
  format: t.variables?.headerFormat || '',
  mediaId: String(m.mediaId || '').trim(),
  link: String(m.link || '').trim(),
  filename: String(m.filename || '').trim(),
});

/** Send one template message to one number, as a test or a single send. */
export async function sendTest(input = {}, adminId = '') {
  const phone = normalizePhone(input.phone);
  if (!phone) throw bad('Enter the phone number to send the test to, with country code');
  const t = await templateFor(input);
  const payload = buildTemplatePayload(t, cleanVars(input.variables), mediaFrom(input.headerMedia, t), { name: input.testName || 'Customer', phone });
  const { sendWhatsAppMessage } = await import('../../services/whatsapp.service.js');
  let wamid;
  try {
    wamid = await sendWhatsAppMessage(phone, payload, { sentBy: `admin-test:${adminId}` });
  } catch (err) {
    throw bad(`WhatsApp refused the message: ${err.message}`);
  }
  if (!wamid) throw bad('WhatsApp is not connected');
  return { wamid, phone };
}

/** Create and start a campaign in one step. */
export async function createCampaign(input = {}, adminId = '') {
  const name = String(input.name || '').trim();
  if (!name) throw bad('Give the campaign a name');
  const t = await templateFor(input);
  const variables = cleanVars(input.variables);
  const headerMedia = mediaFrom(input.headerMedia, t);
  // Fails now, not halfway through, if a media header is missing.
  buildTemplatePayload(t, variables, headerMedia, { name: 'x', phone: 'x' });

  const { people, skippedOptedOut } = await resolveAudience(input.audience || {});
  if (!people.length) throw bad('No customers match this audience (opted-out customers are always left out)');

  const campaign = await WhatsAppCampaign.create({
    name,
    template: { name: t.name, language: t.language, category: t.category, parameterFormat: t.parameter_format || 'POSITIONAL' },
    variables,
    headerMedia,
    audience: input.audience || {},
    status: 'sending',
    totalRecipients: people.length,
    skippedOptedOut,
    createdBy: adminId,
    startedAt: new Date(),
  });
  for (let i = 0; i < people.length; i += 1000) {
    await WhatsAppCampaignRecipient.insertMany(
      people.slice(i, i + 1000).map((p) => ({ campaignId: campaign._id, phone: p.phone, name: p.name })),
      { ordered: false },
    ).catch((err) => { if (err?.code !== 11000 && !err?.writeErrors) throw err; });
  }
  kick();
  return campaign.toObject();
}

export async function cancelCampaign(id) {
  const c = await WhatsAppCampaign.findOneAndUpdate(
    { _id: oid(id), status: { $in: ['sending', 'paused_limit', 'draft'] } },
    { $set: { status: 'cancelled', finishedAt: new Date() } },
    { new: true },
  ).lean();
  if (!c) throw bad('Only a campaign that is still sending can be stopped', 404);
  await WhatsAppCampaignRecipient.updateMany({ campaignId: c._id, state: 'pending' }, { $set: { state: 'skipped', error: 'Campaign stopped' } });
  return c;
}

/** Sent / delivered / read / failed for a set of campaigns, from Meta's receipts. */
async function statsFor(ids) {
  if (!ids.length) return new Map();
  const [byState, byStatus] = await Promise.all([
    WhatsAppCampaignRecipient.aggregate([
      { $match: { campaignId: { $in: ids } } },
      { $group: { _id: { c: '$campaignId', s: '$state' }, n: { $sum: 1 } } },
    ]),
    WhatsAppMessage.aggregate([
      { $match: { campaignId: { $in: ids } } },
      { $group: { _id: { c: '$campaignId', s: '$status' }, n: { $sum: 1 } } },
    ]),
  ]);
  const map = new Map(ids.map((id) => [String(id), { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, accepted: 0, delivered: 0, read: 0, receiptFailed: 0 }]));
  for (const r of byState) {
    const s = map.get(String(r._id.c));
    if (s) s[r._id.s] = r.n;
  }
  for (const r of byStatus) {
    const s = map.get(String(r._id.c));
    if (!s) continue;
    if (r._id.s === 'failed') s.receiptFailed += r.n;
    else if (['accepted', 'sent', 'delivered', 'read'].includes(r._id.s)) s[r._id.s === 'sent' ? 'accepted' : r._id.s] += r.n;
  }
  for (const s of map.values()) {
    // Read implies delivered; both "reached the phone".
    s.deliveredTotal = s.delivered + s.read;
    s.failedTotal = s.failed + s.receiptFailed;
  }
  return map;
}

export async function listCampaigns({ page = 1, limit = 20 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const [rows, total] = await Promise.all([
    WhatsAppCampaign.find({}).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    WhatsAppCampaign.countDocuments({}),
  ]);
  const stats = await statsFor(rows.map((r) => r._id));
  return { campaigns: rows.map((r) => ({ ...r, stats: stats.get(String(r._id)) })), total };
}

/** One campaign: stats, failure reasons, and the customers who replied after it. */
export async function getCampaign(id) {
  const c = await WhatsAppCampaign.findById(oid(id)).lean();
  if (!c) throw bad('Campaign not found', 404);
  const stats = (await statsFor([c._id])).get(String(c._id));
  const [failures, recipients] = await Promise.all([
    WhatsAppMessage.aggregate([
      { $match: { campaignId: c._id, status: 'failed' } },
      { $group: { _id: '$error', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 10 },
    ]),
    WhatsAppCampaignRecipient.find({ campaignId: c._id }).sort({ sentAt: -1 }).limit(500).lean(),
  ]);
  const sendFailures = await WhatsAppCampaignRecipient.aggregate([
    { $match: { campaignId: c._id, state: 'failed' } },
    { $group: { _id: '$error', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 10 },
  ]);
  const wamids = recipients.map((r) => r.wamid).filter(Boolean);
  const receipt = new Map(
    (await WhatsAppMessage.find({ wamid: { $in: wamids } }).select('wamid status error').lean()).map((m) => [m.wamid, m]),
  );
  const replies = c.startedAt
    ? await WhatsAppMessage.find({ direction: 'in', phone: { $in: recipients.map((r) => r.phone) }, createdAt: { $gte: c.startedAt } })
      .sort({ createdAt: -1 }).limit(100).select('phone contactName text type createdAt').lean()
    : [];
  return {
    campaign: { ...c, stats },
    failureReasons: [...sendFailures, ...failures].filter((f) => f._id).map((f) => ({ reason: f._id, count: f.n })),
    recipients: recipients.map((r) => ({
      phone: r.phone,
      name: r.name,
      state: r.state,
      status: receipt.get(r.wamid)?.status || '',
      error: r.error || receipt.get(r.wamid)?.error || '',
      sentAt: r.sentAt,
    })),
    replies,
  };
}

/** Overall delivery report over the last N days, every template message. */
export async function deliveryReport({ days = 30 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 365) * 86400000);
  const rows = await WhatsAppMessage.aggregate([
    { $match: { direction: 'out', createdAt: { $gte: since } } },
    { $group: { _id: { kind: { $cond: [{ $ne: ['$campaignId', null] }, 'campaign', { $cond: [{ $regexMatch: { input: '$sentBy', regex: '^order:' } }, 'order', 'other'] }] }, status: '$status' }, n: { $sum: 1 } } },
  ]);
  const report = {};
  for (const r of rows) {
    const k = r._id.kind;
    report[k] = report[k] || { total: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    report[k].total += r.n;
    if (report[k][r._id.status] !== undefined) report[k][r._id.status] += r.n;
  }
  const inbound = await WhatsAppMessage.countDocuments({ direction: 'in', createdAt: { $gte: since } });
  return { since, report, inbound };
}

/* -------------------------------------------------------------- sender -- */

const PER_TICK = 20;
const TICK_MS = 5000;
let running = false;
let timer = null;

/**
 * Customers this number started a template conversation with in the last
 * 24 hours: what Meta's messaging limit counts.
 */
async function usedInWindow() {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const phones = await WhatsAppMessage.distinct('phone', { direction: 'out', type: 'template', createdAt: { $gte: since } });
  return new Set(phones);
}

const LIMIT_CODES = new Set([130429, 131048, 131056, 80007]);

async function sendOne(campaign, template, row, used, limit) {
  if (!used.has(row.phone) && used.size >= limit) return 'limit';
  if (await WhatsAppContact.exists({ phone: row.phone, marketing: 'opted_out' })) {
    await WhatsAppCampaignRecipient.updateOne({ _id: row._id }, { $set: { state: 'skipped', error: 'Opted out' } });
    return 'skipped';
  }
  const payload = buildTemplatePayload(template, campaign.variables, campaign.headerMedia, { name: row.name || 'Customer', phone: row.phone });
  const { sendWhatsAppMessage } = await import('../../services/whatsapp.service.js');
  try {
    const wamid = await sendWhatsAppMessage(row.phone, payload, { sentBy: `campaign:${campaign._id}`, campaignId: campaign._id });
    if (!wamid) throw new Error('WhatsApp is not connected');
    await WhatsAppCampaignRecipient.updateOne({ _id: row._id }, { $set: { state: 'sent', wamid: String(wamid), sentAt: new Date(), error: '' } });
    used.add(row.phone);
    return 'sent';
  } catch (err) {
    const code = Number(err.metaCode) || Number(/\(#(\d+)\)/.exec(err.message)?.[1]) || 0;
    if (LIMIT_CODES.has(code) || /rate limit|too many/i.test(err.message)) {
      await WhatsAppCampaignRecipient.updateOne({ _id: row._id }, { $set: { state: 'pending', claimedAt: null } });
      return 'limit';
    }
    await WhatsAppCampaignRecipient.updateOne({ _id: row._id }, { $set: { state: 'failed', error: String(err.message).slice(0, 300) } });
    return 'failed';
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // A row left mid-send by a restart is not retried: it may have gone out.
    await WhatsAppCampaignRecipient.updateMany(
      { state: 'sending', claimedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
      { $set: { state: 'failed', error: 'Interrupted while sending (server restart); not retried to avoid a duplicate' } },
    );
    const campaigns = await WhatsAppCampaign.find({ status: { $in: ['sending', 'paused_limit'] } }).sort({ startedAt: 1 }).lean();
    if (!campaigns.length) return;

    let limit = 250;
    try { limit = (await phoneInfo()).dailyLimit; } catch { /* keep the safe default */ }
    const used = await usedInWindow();
    let budget = PER_TICK;

    for (const campaign of campaigns) {
      if (budget <= 0) break;
      let template;
      try {
        template = await findTemplate(campaign.template.name, campaign.template.language);
      } catch (err) {
        await WhatsAppCampaign.updateOne({ _id: campaign._id }, { $set: { lastError: `Could not load the template: ${err.message}` } });
        continue;
      }
      if (!template || template.status !== 'APPROVED') {
        await WhatsAppCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'cancelled', finishedAt: new Date(), lastError: 'The template is no longer approved on Meta' } });
        continue;
      }

      let hitLimit = false;
      while (budget > 0) {
        const row = await WhatsAppCampaignRecipient.findOneAndUpdate(
          { campaignId: campaign._id, state: 'pending' },
          { $set: { state: 'sending', claimedAt: new Date() } },
          { new: true },
        ).lean();
        if (!row) break;
        budget -= 1;
        const result = await sendOne(campaign, template, row, used, limit);
        if (result === 'limit') {
          await WhatsAppCampaignRecipient.updateOne({ _id: row._id, state: 'sending' }, { $set: { state: 'pending', claimedAt: null } });
          hitLimit = true;
          break;
        }
      }

      const left = await WhatsAppCampaignRecipient.countDocuments({ campaignId: campaign._id, state: { $in: ['pending', 'sending'] } });
      if (!left) {
        await WhatsAppCampaign.updateOne({ _id: campaign._id, status: { $in: ['sending', 'paused_limit'] } }, { $set: { status: 'done', finishedAt: new Date(), lastError: '' } });
      } else if (hitLimit) {
        await WhatsAppCampaign.updateOne({ _id: campaign._id, status: 'sending' }, {
          $set: { status: 'paused_limit', lastError: `Meta's limit of ${limit} customers a day is reached; the rest go out automatically as the 24-hour window frees up` },
        });
        break;
      } else if (campaign.status === 'paused_limit') {
        await WhatsAppCampaign.updateOne({ _id: campaign._id, status: 'paused_limit' }, { $set: { status: 'sending', lastError: '' } });
      }
    }
  } catch (err) {
    logger.error(`[WhatsApp] campaign sender: ${err.message}`);
  } finally {
    running = false;
  }
}

function kick() {
  setImmediate(() => { tick().catch(() => {}); });
}

/** Started once, from the routes module, in the API process. */
export function startCampaignSender() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  kick();
}
