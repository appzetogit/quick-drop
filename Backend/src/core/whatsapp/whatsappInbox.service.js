/**
 * WhatsApp inbox: what the webhook receives, what the platform sends, and the
 * admin's view of both (Master > WhatsApp).
 *
 * Receipts only move forward: Meta can deliver "delivered" after "read" (the
 * webhooks are not ordered), so a lower status never replaces a higher one.
 * "failed" always lands, with Meta's reason.
 */
import { WhatsAppMessage } from './whatsappMessage.model.js';
import { handleInboundForContacts } from './whatsappContacts.service.js';
import { logger } from '../../utils/logger.js';

const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** What a message says, in one line of text, whatever its type. */
export const messageText = (m = {}) => {
  switch (m.type) {
    case 'text': return m.text?.body || '';
    case 'button': return m.button?.text || '';
    case 'interactive':
      return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || m.interactive?.nfm_reply?.body || '';
    case 'image': case 'video': case 'document': case 'audio': case 'sticker':
      return m[m.type]?.caption || m[m.type]?.filename || '';
    case 'location': {
      const l = m.location || {};
      return [l.name, l.address, l.latitude != null ? `${l.latitude}, ${l.longitude}` : ''].filter(Boolean).join(' · ');
    }
    case 'reaction': return m.reaction?.emoji || '';
    case 'contacts': return (m.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ');
    case 'order': return `Order with ${(m.order?.product_items || []).length} item(s)`;
    default: return '';
  }
};

const outgoingText = (payload = {}) => {
  if (payload.type === 'text') return payload.text?.body || '';
  if (payload.type === 'template') return `Template: ${payload.template?.name || ''}`;
  return payload[payload.type]?.caption || '';
};

/** A message we sent. The receipts may already be here (they can beat the API response). */
export async function recordOutgoingWhatsApp({ wamid, phone, payload = {}, phoneNumberId = '', sentBy = '', campaignId = null }) {
  await WhatsAppMessage.updateOne(
    { wamid },
    {
      $set: {
        type: payload.type || 'unknown',
        text: outgoingText(payload),
        sentBy,
        phoneNumberId,
        readByAdmin: true,
        templateName: payload.type === 'template' ? String(payload.template?.name || '') : '',
        campaignId: campaignId || null,
      },
      $setOnInsert: { wamid, direction: 'out', phone: digits(phone), status: 'accepted', sentAt: new Date() },
    },
    { upsert: true },
  );
}

async function storeIncoming(m, { contactName, phoneNumberId }) {
  if (!m?.id || !m.from) return;
  await WhatsAppMessage.updateOne(
    { wamid: m.id },
    {
      $setOnInsert: {
        wamid: m.id,
        direction: 'in',
        phone: digits(m.from),
        contactName: contactName || '',
        type: m.type || 'unknown',
        text: messageText(m),
        status: 'received',
        phoneNumberId,
        sentAt: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
        raw: m,
        readByAdmin: false,
      },
    },
    { upsert: true },
  );
}

async function storeStatus(st, { phoneNumberId }) {
  if (!st?.id || !st.status) return;
  const at = st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();
  const error = (st.errors || []).map((e) => [e.code, e.title, e.error_data?.details].filter(Boolean).join(' ')).join('; ');
  await WhatsAppMessage.updateOne(
    { wamid: st.id },
    {
      $push: { statusHistory: { status: st.status, at, error } },
      $setOnInsert: { wamid: st.id, direction: 'out', phone: digits(st.recipient_id), status: 'accepted', phoneNumberId, sentAt: at, readByAdmin: true },
    },
    { upsert: true },
  );
  if (st.status === 'failed') {
    await WhatsAppMessage.updateOne({ wamid: st.id }, { $set: { status: 'failed', error } });
    return;
  }
  const rank = RANK[st.status];
  if (rank === undefined) return;
  const lower = Object.keys(RANK).filter((k) => RANK[k] < rank);
  await WhatsAppMessage.updateOne({ wamid: st.id, status: { $in: lower } }, { $set: { status: st.status } });
}

/**
 * One webhook delivery from Meta (already signature-checked). Only the
 * "messages" field is handled; anything else is acknowledged and ignored.
 * Returns what was stored, for the log and the tests.
 */
export async function processWhatsAppWebhook(body = {}) {
  const out = { messages: 0, statuses: 0 };
  if (body.object !== 'whatsapp_business_account') return out;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const v = change.value || {};
      const phoneNumberId = String(v.metadata?.phone_number_id || '');
      const names = new Map((v.contacts || []).map((c) => [digits(c.wa_id), c.profile?.name || '']));
      for (const m of v.messages || []) {
        await storeIncoming(m, { contactName: names.get(digits(m.from)), phoneNumberId });
        // STOP / START keywords and the last-seen time for the contact list.
        // Never fails the webhook: the message itself is already stored.
        await handleInboundForContacts(m, names.get(digits(m.from)))
          .catch((err) => logger.warn(`[WhatsApp] contact update failed for ${digits(m.from)}: ${err.message}`));
        out.messages += 1;
      }
      for (const st of v.statuses || []) {
        await storeStatus(st, { phoneNumberId });
        out.statuses += 1;
      }
    }
  }
  if (out.messages || out.statuses) logger.info(`[WhatsApp] webhook: ${out.messages} message(s), ${out.statuses} receipt(s)`);
  return out;
}

/* ------------------------------------------------------------- admin -- */

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Conversations, newest first: one row per customer number. */
export async function listConversations({ search = '', limit = 50 } = {}) {
  const q = String(search || '').trim();
  const match = q
    ? { $or: [{ phone: { $regex: escapeRx(digits(q) || q) } }, { contactName: { $regex: escapeRx(q), $options: 'i' } }] }
    : {};
  const rows = await WhatsAppMessage.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$phone',
        last: { $first: '$$ROOT' },
        names: { $push: '$contactName' },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $eq: ['$readByAdmin', false] }] }, 1, 0] } },
        lastIncomingAt: { $max: { $cond: [{ $eq: ['$direction', 'in'] }, '$createdAt', null] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { 'last.createdAt': -1 } },
    { $limit: Math.min(Number(limit) || 50, 200) },
  ]);
  return rows.map((r) => ({
    phone: r._id,
    contactName: (r.names || []).find(Boolean) || '',
    lastText: r.last.text || r.last.type,
    lastDirection: r.last.direction,
    lastStatus: r.last.status,
    lastAt: r.last.createdAt,
    unread: r.unread,
    count: r.count,
    canReply: Boolean(r.lastIncomingAt && Date.now() - new Date(r.lastIncomingAt).getTime() < 24 * 3600 * 1000),
  }));
}

/** One conversation, oldest first, and marks its incoming messages read. */
export async function getConversation(phone, { limit = 200 } = {}) {
  const p = digits(phone);
  if (!p) throw bad('Phone number is required');
  const messages = await WhatsAppMessage.find({ phone: p })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 200, 500))
    .select('-raw')
    .lean();
  messages.reverse();
  await WhatsAppMessage.updateMany({ phone: p, direction: 'in', readByAdmin: false }, { $set: { readByAdmin: true } });
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  return {
    phone: p,
    contactName: messages.map((m) => m.contactName).filter(Boolean).pop() || '',
    // Meta allows a free-form reply only within 24 hours of the customer's last message.
    canReply: Boolean(lastIn && Date.now() - new Date(lastIn.createdAt).getTime() < 24 * 3600 * 1000),
    messages,
  };
}

/** A free-form text reply from an admin. */
export async function replyToConversation(phone, text, adminId = '') {
  const p = digits(phone);
  const body = String(text ?? '').trim();
  if (!p) throw bad('Phone number is required');
  if (!body) throw bad('Type a message');
  if (body.length > 4096) throw bad('A WhatsApp message can be at most 4096 characters');
  const { sendWhatsAppMessage } = await import('../../services/whatsapp.service.js');
  let wamid;
  try {
    wamid = await sendWhatsAppMessage(p, { type: 'text', text: { preview_url: false, body } }, { sentBy: `admin:${adminId}` });
  } catch (err) {
    throw bad(`WhatsApp refused the message: ${err.message}`);
  }
  if (!wamid) throw bad('WhatsApp is not set up: save the access token and phone number id in Master settings first');
  return { wamid };
}

export async function unreadCount() {
  return WhatsAppMessage.countDocuments({ direction: 'in', readByAdmin: false });
}

/** The last time Meta reached the webhook with anything we stored. */
export async function lastWebhookActivity() {
  const [lastIn, lastReceipt] = await Promise.all([
    WhatsAppMessage.findOne({ direction: 'in' }).sort({ createdAt: -1 }).select('createdAt').lean(),
    WhatsAppMessage.findOne({ 'statusHistory.0': { $exists: true } }).sort({ updatedAt: -1 }).select('updatedAt').lean(),
  ]);
  return { lastMessageAt: lastIn?.createdAt || null, lastReceiptAt: lastReceipt?.updatedAt || null };
}
