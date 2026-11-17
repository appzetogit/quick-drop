import nodemailer from 'nodemailer';
import { sendResponse, sendError } from '../../utils/response.js';
import { logger } from '../../utils/logger.js';
import {
  getPlatformProfileForAdmin,
  updatePlatformProfile,
  getPlatformProfile,
  razorpayCredentials,
  checkRazorpayPair,
  smsCredentials,
  whatsappCredentials,
} from './platformProfile.service.js';

const actorOf = (req) => String(req.financeActor?.adminId || req.user?.userId || '');

export const getProfileController = async (_req, res) => {
  try {
    return sendResponse(res, 200, 'Master settings', await getPlatformProfileForAdmin());
  } catch (err) {
    return sendError(res, 500, err.message || 'Could not load master settings');
  }
};

export const updateProfileController = async (req, res) => {
  try {
    const result = await updatePlatformProfile(req.body || {}, actorOf(req));
    logger.info(`platformProfile: ${actorOf(req) || 'unknown admin'} saved ${Object.keys(req.body || {}).join(', ')}`);
    return sendResponse(res, 200, 'Saved', result);
  } catch (err) {
    return sendError(res, err.statusCode || 500, err.message || 'Could not save');
  }
};

/*
 * Connection tests. Each checks the values an admin is about to use -- the
 * ones in the request, falling back to what is saved -- without changing
 * anything, so a wrong key is caught before payments or OTPs depend on it.
 * A masked secret (starts with •) means "the one already saved".
 */
const pick = (incoming, saved) => (incoming && !String(incoming).startsWith('•') ? String(incoming).trim() : saved);

export const testRazorpayController = async (req, res) => {
  try {
    const saved = razorpayCredentials();
    const profile = await getPlatformProfile();
    const keyId = pick(req.body?.keyId, profile.integrations?.razorpay?.keyId || saved.keyId);
    const keySecret = pick(req.body?.keySecret, profile.integrations?.razorpay?.keySecret || saved.keySecret);
    if (!keyId || !keySecret) return sendError(res, 400, 'Enter the key id and key secret first');
    const check = await checkRazorpayPair(keyId, keySecret);
    if (!check.ok) return sendError(res, 400, check.rejected ? check.message : `${check.message}; try again`);
    return sendResponse(res, 200, `Keys work (${keyId.startsWith('rzp_live') ? 'LIVE' : 'TEST'} mode)`, { ok: true });
  } catch (err) {
    return sendError(res, 400, `Could not reach Razorpay: ${err.message}`);
  }
};

export const testEmailController = async (req, res) => {
  try {
    const profile = await getPlatformProfile();
    const m = profile.integrations?.email || {};
    const b = req.body || {};
    const host = pick(b.host, m.host);
    const port = Number(b.port || m.port) || 587;
    const user = pick(b.user, m.user);
    const pass = pick(b.pass, m.pass);
    if (!host || !user || !pass) return sendError(res, 400, 'Enter the mail server, user and password first');
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 10000 });
    await transport.verify();
    const to = String(b.sendTo || '').trim();
    if (to) {
      await transport.sendMail({ from: pick(b.from, m.from) || user, to, subject: 'Quick Drop: test email', text: 'Your mail settings work.' });
      return sendResponse(res, 200, `Connected, and a test email was sent to ${to}`, { ok: true });
    }
    return sendResponse(res, 200, 'Connected to the mail server', { ok: true });
  } catch (err) {
    return sendError(res, 400, `Mail server refused: ${err.message}`);
  }
};

export const testSmsController = async (req, res) => {
  try {
    const profile = await getPlatformProfile();
    const s = profile.integrations?.sms || {};
    const current = smsCredentials();
    const b = req.body || {};
    const apiKey = pick(b.apiKey, s.apiKey || current.apiKey);
    const senderId = pick(b.senderId, s.senderId || current.senderId);
    const templateId = pick(b.templateId, s.templateId || current.templateId);
    const template = pick(b.templateText, s.templateText || current.templateText);
    const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
    if (!apiKey || !senderId) return sendError(res, 400, 'Enter the API key and sender id first');
    if (phone.length !== 10) return sendError(res, 400, 'Enter a 10-digit mobile number to send the test to');
    if (!template || !template.includes('{{OTP}}')) return sendError(res, 400, 'The template must contain {{OTP}}');
    const url = new URL(String(process.env.SMS_INDIA_HUB_URL || '').trim() || 'http://cloud.smsindiahub.in/vendorsms/pushsms.aspx');
    url.searchParams.append('APIKey', apiKey);
    url.searchParams.append('sid', senderId);
    url.searchParams.append('msisdn', `91${phone}`);
    url.searchParams.append('msg', template.replace(/\{\{OTP\}\}/g, '123456').replace(/\{\{MINUTES\}\}/g, '5'));
    url.searchParams.append('fl', '0');
    url.searchParams.append('gwid', '2');
    if (templateId) url.searchParams.append('DLT_TE_ID', templateId);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = (await response.text()).slice(0, 300);
    if (!response.ok || /error|invalid|fail/i.test(text)) return sendError(res, 400, `SMS provider answered: ${text || response.status}`);
    return sendResponse(res, 200, `Test SMS sent to ${phone} (code 123456)`, { ok: true, provider: text });
  } catch (err) {
    return sendError(res, 400, `Could not reach the SMS provider: ${err.message}`);
  }
};

/**
 * WhatsApp: asks Meta for the business number behind the phone number id with
 * the access token (nothing is sent to anyone). With a WhatsApp business
 * account id it also subscribes this app to that account, which is what makes
 * Meta deliver the account's messages and receipts to our webhook; repeating
 * it is harmless.
 */
export const testWhatsAppController = async (req, res) => {
  try {
    const profile = await getPlatformProfile();
    const w = profile.integrations?.whatsapp || {};
    const current = whatsappCredentials();
    const b = req.body || {};
    const accessToken = pick(b.accessToken, w.accessToken || current.accessToken);
    const phoneNumberId = pick(b.phoneNumberId, w.phoneNumberId || current.phoneNumberId);
    const businessAccountId = pick(b.businessAccountId, w.businessAccountId || current.businessAccountId);
    if (!accessToken || !phoneNumberId) return sendError(res, 400, 'Enter the access token and phone number id first');
    const graph = `https://graph.facebook.com/${current.version}`;
    const auth = { Authorization: `Bearer ${accessToken}` };
    const metaError = async (r) => (await r.json().catch(() => ({})))?.error?.message || `Meta answered ${r.status}`;

    const phoneRes = await fetch(`${graph}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, { headers: auth, signal: AbortSignal.timeout(15000) });
    if (!phoneRes.ok) return sendError(res, 400, `Meta rejected the token or phone number id: ${await metaError(phoneRes)}`);
    const phone = await phoneRes.json();
    let message = `Works: ${phone.verified_name || 'business'} (${phone.display_phone_number || phoneNumberId})`;

    if (businessAccountId) {
      const subRes = await fetch(`${graph}/${encodeURIComponent(businessAccountId)}/subscribed_apps`, { method: 'POST', headers: auth, signal: AbortSignal.timeout(15000) });
      message += subRes.ok
        ? '. This app is subscribed to the account, so messages and receipts will reach the webhook.'
        : `. Could not subscribe the app to the business account: ${await metaError(subRes)}`;
    } else {
      message += '. Add the WhatsApp business account id to subscribe the webhook too.';
    }
    return sendResponse(res, 200, message, { ok: true, phone });
  } catch (err) {
    return sendError(res, 400, `Could not reach Meta: ${err.message}`);
  }
};
