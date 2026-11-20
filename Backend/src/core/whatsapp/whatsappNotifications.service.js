/**
 * Automatic WhatsApp order updates: an approved template goes to the customer
 * when their food or grocery/medical order is accepted, picked up by the
 * rider, or delivered. Which template (if any) is chosen per event in the
 * admin's WhatsApp Marketing > Order alerts.
 *
 * Never throws and never slows the order: callers fire and forget. Each
 * (order, event) is sent at most once, whichever code path reports it.
 */
import mongoose from 'mongoose';
import { WhatsAppNotificationSettings } from './whatsappMarketing.models.js';
import { WhatsAppMessage } from './whatsappMessage.model.js';
import { normalizePhone } from './whatsappContacts.service.js';
import { buildTemplatePayload, findTemplate } from './whatsappMeta.service.js';
import { logger } from '../../utils/logger.js';

export const ORDER_EVENTS = {
  confirmed: 'Order accepted by the restaurant / store',
  picked_up: 'Order picked up (out for delivery)',
  delivered: 'Order delivered',
};
export const ORDER_PLACEHOLDERS = ['customer_name', 'order_id', 'amount', 'store_name'];

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

let cache = { at: 0, value: null };
async function settings() {
  if (cache.value && Date.now() - cache.at < 30000) return cache.value;
  const doc = await WhatsAppNotificationSettings.findById('default').lean();
  cache = { at: Date.now(), value: doc?.events || {} };
  return cache.value;
}

export async function getNotificationSettings() {
  const doc = await WhatsAppNotificationSettings.findById('default').lean();
  return { events: doc?.events || {}, eventLabels: ORDER_EVENTS, placeholders: ORDER_PLACEHOLDERS, updatedAt: doc?.updatedAt || null };
}

export async function saveNotificationSettings(input = {}, adminId = '') {
  const events = {};
  for (const key of Object.keys(ORDER_EVENTS)) {
    const e = input.events?.[key] || {};
    const enabled = Boolean(e.enabled);
    const templateName = String(e.templateName || '').trim();
    const language = String(e.language || '').trim();
    if (enabled) {
      if (!templateName || !language) throw bad(`Choose a template for "${ORDER_EVENTS[key]}" or switch it off`);
      const t = await findTemplate(templateName, language);
      if (!t) throw bad(`Template ${templateName} (${language}) is not on the WhatsApp account`);
      if (t.status !== 'APPROVED') throw bad(`Template ${templateName} is not approved yet`);
      if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.variables?.headerFormat) && !(e.headerMedia?.mediaId || e.headerMedia?.link)) {
        throw bad(`Template ${templateName} has a media header: add the image/video link for it`);
      }
    }
    events[key] = {
      enabled,
      templateName,
      language,
      body: e.body && typeof e.body === 'object' ? e.body : {},
      header: e.header && typeof e.header === 'object' ? e.header : {},
      buttons: e.buttons && typeof e.buttons === 'object' ? e.buttons : {},
      headerMedia: { mediaId: String(e.headerMedia?.mediaId || ''), link: String(e.headerMedia?.link || ''), filename: String(e.headerMedia?.filename || '') },
    };
  }
  await WhatsAppNotificationSettings.updateOne(
    { _id: 'default' },
    { $set: { events, updatedBy: adminId } },
    { upsert: true },
  );
  cache = { at: 0, value: null };
  return getNotificationSettings();
}

async function storeName(module, order) {
  const id = order?.restaurantId?._id || order?.restaurantId;
  if (order?.restaurantId?.restaurantName) return order.restaurantId.restaurantName;
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return '';
  const modelName = module === 'quick' ? 'QCRestaurant' : 'FoodRestaurant';
  const Model = mongoose.models[modelName];
  if (!Model) return '';
  const r = await Model.findById(id).select('restaurantName').lean().catch(() => null);
  return r?.restaurantName || '';
}

const sentKeys = new Set();

/**
 * module: 'food' | 'quick'; event: 'confirmed' | 'picked_up' | 'delivered'.
 * Resolves to the Meta message id, or null when nothing was sent.
 */
export async function notifyOrderEvent(module, event, order) {
  try {
    if (!order || !ORDER_EVENTS[event]) return null;
    const cfg = (await settings())[event];
    if (!cfg?.enabled || !cfg.templateName) return null;

    const orderKey = String(order._id || order.order_id || '');
    const key = `order:${module}:${orderKey}:${event}`;
    if (!orderKey || sentKeys.has(key)) return null;
    sentKeys.add(key);
    if (sentKeys.size > 5000) sentKeys.clear();
    if (await WhatsAppMessage.exists({ sentBy: key })) return null;

    const phone = normalizePhone(order.customerPhone || order.deliveryAddress?.phone || order.recipientDetails?.phone);
    if (!phone) return null;
    const t = await findTemplate(cfg.templateName, cfg.language);
    if (!t || t.status !== 'APPROVED') {
      logger.warn(`[WhatsApp] order alert "${event}" skipped: template ${cfg.templateName} is not approved`);
      return null;
    }
    const amount = Number(order.pricing?.total ?? order.amounts?.totalCustomerPaid ?? 0);
    const ctx = {
      customer_name: order.customerName || order.deliveryAddress?.name || order.deliveryAddress?.fullName || 'Customer',
      name: order.customerName || 'Customer',
      order_id: order.order_id || order.orderId || String(order._id || ''),
      amount: Number.isFinite(amount) ? `Rs ${amount.toFixed(amount % 1 ? 2 : 0)}` : '',
      store_name: await storeName(module, order),
      phone,
    };
    const payload = buildTemplatePayload(t, { header: cfg.header, body: cfg.body, buttons: cfg.buttons }, { ...cfg.headerMedia, format: t.variables?.headerFormat }, ctx);
    const { sendWhatsAppMessage } = await import('../../services/whatsapp.service.js');
    const wamid = await sendWhatsAppMessage(phone, payload, { sentBy: key });
    return wamid || null;
  } catch (err) {
    logger.warn(`[WhatsApp] order alert ${module}/${event} for ${order?.order_id || order?._id} failed: ${err.message}`);
    return null;
  }
}

/** Fire-and-forget wrapper for the order code paths. */
export const queueOrderWhatsApp = (module, event, order) => {
  // Plain copy: the caller may keep mutating its document.
  const snapshot = order?.toObject ? order.toObject() : order;
  setImmediate(() => { notifyOrderEvent(module, event, snapshot).catch(() => {}); });
};
