/**
 * WhatsApp contacts: who has said yes or no to promotional messages.
 *
 * A customer replying STOP (or tapping a "Stop promotions" button) is opted
 * out and never gets a campaign again until they reply START. Order updates
 * (utility messages) are not promotions and still go out.
 */
import mongoose from 'mongoose';
import { WhatsAppContact } from './whatsappMarketing.models.js';
import { logger } from '../../utils/logger.js';

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** Digits with the country code; a bare 10-digit Indian number gets 91. */
export const normalizePhone = (value) => {
  let d = digits(value);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = `91${d}`;
  if (d.length === 11 && d.startsWith('0')) d = `91${d.slice(1)}`;
  return d.length >= 11 && d.length <= 15 ? d : '';
};

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'stop promotions', 'stop promotion', 'opt out', 'optout', 'band', 'बंद', 'रोकें']);
const START_WORDS = new Set(['start', 'subscribe', 'opt in', 'optin', 'resume promotions', 'चालू']);

const inboundWord = (m = {}) => {
  const raw = m.type === 'text' ? m.text?.body
    : m.type === 'button' ? (m.button?.text || m.button?.payload)
      : m.type === 'interactive' ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title)
        : '';
  return String(raw || '').trim().toLowerCase().replace(/[.!]+$/, '');
};

async function setMarketing(phone, marketing, by, extra = {}) {
  const p = normalizePhone(phone);
  if (!p) throw bad('Enter a valid phone number with country code');
  const doc = await WhatsAppContact.findOneAndUpdate(
    { phone: p },
    {
      $set: { marketing, marketingChangedAt: new Date(), marketingChangedBy: by, ...extra },
      $setOnInsert: { phone: p },
    },
    { upsert: true, new: true },
  ).lean();
  return doc;
}

/** Called for every incoming message: STOP / START keywords and last-seen time. */
export async function handleInboundForContacts(m, contactName = '') {
  const p = normalizePhone(m?.from);
  if (!p) return;
  const word = inboundWord(m);
  const set = { lastInboundAt: new Date() };
  if (contactName) set.name = contactName;

  if (STOP_WORDS.has(word) || START_WORDS.has(word)) {
    const optOut = STOP_WORDS.has(word);
    await setMarketing(p, optOut ? 'opted_out' : 'opted_in', `customer:${optOut ? 'STOP' : 'START'}`, set);
    // The customer just wrote to us, so a free-form reply is allowed.
    try {
      const { sendWhatsAppMessage } = await import('../../services/whatsapp.service.js');
      const body = optOut
        ? 'You will no longer receive offers from Quickdrops on WhatsApp. Order updates will still reach you. Reply START to get offers again.'
        : 'You are subscribed to offers from Quickdrops on WhatsApp. Reply STOP any time to stop them.';
      await sendWhatsAppMessage(p, { type: 'text', text: { preview_url: false, body } }, { sentBy: 'opt-confirmation' });
    } catch (err) {
      logger.warn(`[WhatsApp] could not confirm ${optOut ? 'opt-out' : 'opt-in'} to ${p}: ${err.message}`);
    }
    return;
  }
  await WhatsAppContact.updateOne({ phone: p }, { $set: set, $setOnInsert: { phone: p } }, { upsert: true });
}

/** Phones (from a list) that have opted out of promotions. */
export async function optedOutAmong(phones = []) {
  if (!phones.length) return new Set();
  const rows = await WhatsAppContact.find({ phone: { $in: phones }, marketing: 'opted_out' }).select('phone').lean();
  return new Set(rows.map((r) => r.phone));
}

export async function optedInAmong(phones = []) {
  if (!phones.length) return new Set();
  const rows = await WhatsAppContact.find({ phone: { $in: phones }, marketing: 'opted_in' }).select('phone').lean();
  return new Set(rows.map((r) => r.phone));
}

export async function isOptedOut(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  return Boolean(await WhatsAppContact.exists({ phone: p, marketing: 'opted_out' }));
}

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Admin list: contacts with a marketing choice or a message from them. */
export async function listContacts({ search = '', marketing = '', page = 1, limit = 50 } = {}) {
  const filter = {};
  if (['opted_in', 'opted_out', 'unknown'].includes(marketing)) filter.marketing = marketing;
  const q = String(search || '').trim();
  if (q) filter.$or = [{ phone: { $regex: escapeRx(digits(q) || q) } }, { name: { $regex: escapeRx(q), $options: 'i' } }];
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const [rows, total, counts] = await Promise.all([
    WhatsAppContact.find(filter).sort({ marketingChangedAt: -1, updatedAt: -1 }).skip(skip).limit(lim).lean(),
    WhatsAppContact.countDocuments(filter),
    WhatsAppContact.aggregate([{ $group: { _id: '$marketing', n: { $sum: 1 } } }]),
  ]);
  return {
    contacts: rows,
    total,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
  };
}

/** Admin change: opt a number in or out of promotions. */
export async function adminSetMarketing(phone, marketing, adminId = '') {
  if (!['opted_in', 'opted_out'].includes(marketing)) throw bad('Choose opted in or opted out');
  let userId = null;
  const p = normalizePhone(phone);
  try {
    const { FoodUser } = await import('../users/user.model.js');
    const local = p.startsWith('91') ? p.slice(2) : p;
    const user = await FoodUser.findOne({ phone: { $in: [local, p, `+${p}`] } }).select('_id name').lean();
    if (user) userId = new mongoose.Types.ObjectId(String(user._id));
  } catch { /* the user link is optional */ }
  return setMarketing(phone, marketing, `admin:${adminId}`, userId ? { userId } : {});
}
