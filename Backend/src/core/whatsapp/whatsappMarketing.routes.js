import express from 'express';
import multer from 'multer';
import { authMiddleware } from '../auth/auth.middleware.js';
import { requireRoles } from '../roles/role.middleware.js';
import { requireFinancePermission } from '../admin/requireFinancePermission.middleware.js';
import { sendResponse, sendError } from '../../utils/response.js';
import { whatsappCredentials } from '../settings/platformProfile.service.js';
import * as meta from './whatsappMeta.service.js';
import * as campaigns from './whatsappCampaign.service.js';
import * as contacts from './whatsappContacts.service.js';
import * as notifications from './whatsappNotifications.service.js';
import { lastWebhookActivity, unreadCount } from './whatsappInbox.service.js';

/**
 * Master > WhatsApp Marketing: /v1/platform/whatsapp/marketing.
 * Reading needs an admin login. Anything that sends, or changes what is sent,
 * speaks for the whole business and needs PLATFORM_SETTING_SET (the same as
 * replying in the WhatsApp inbox).
 */
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const canSend = requireFinancePermission('PLATFORM_SETTING_SET');

router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
router.use(authMiddleware, requireRoles('ADMIN'));

const handle = (fn, message = 'OK') => async (req, res) => {
  try {
    return sendResponse(res, 200, message, await fn(req));
  } catch (err) {
    const status = err?.statusCode || err?.status || 500;
    return sendError(res, status, status >= 500 && status !== 502 ? 'Could not complete that. Please try again.' : err.message);
  }
};
const adminId = (req) => String(req.financeActor?.adminId || req.user?.userId || req.user?.id || '');

// Connection: our settings, Meta's view of the number, webhook health.
router.get('/status', handle(async () => {
  const c = whatsappCredentials();
  const base = {
    connected: Boolean(c.accessToken && c.phoneNumberId),
    phoneNumberId: c.phoneNumberId,
    businessAccountId: c.businessAccountId,
    appSecretSet: Boolean(c.appSecret),
    verifyTokenSet: Boolean(c.verifyToken),
    webhookUrl: '/api/v1/whatsapp/webhook',
    unread: await unreadCount(),
    ...(await lastWebhookActivity()),
  };
  if (!base.connected) return { ...base, meta: null, metaError: 'Not connected' };
  try {
    const info = await meta.phoneInfo({ fresh: true });
    return { ...base, meta: { ...info, dailyLimit: Number.isFinite(info.dailyLimit) ? info.dailyLimit : null } };
  } catch (err) {
    return { ...base, meta: null, metaError: err.message };
  }
}));

// Templates
router.get('/templates', handle((req) => meta.listTemplates({ fresh: req.query.fresh === '1' })));
router.post('/templates', canSend, handle((req) => meta.createTemplate(req.body || {}), 'Template submitted to Meta for review'));
router.post('/media', canSend, upload.single('file'), handle(async (req) => {
  const f = req.file;
  if (!f) throw Object.assign(new Error('Choose a file'), { statusCode: 400 });
  if (!/^(image\/(jpeg|png)|video\/(mp4|3gpp)|application\/pdf)$/.test(f.mimetype)) {
    throw Object.assign(new Error('Use a JPG or PNG image, an MP4 video or a PDF'), { statusCode: 400 });
  }
  const r = await meta.uploadMedia({ buffer: f.buffer, mimetype: f.mimetype, filename: f.originalname });
  return { ...r, filename: f.originalname, mimetype: f.mimetype };
}, 'Uploaded'));

// Campaigns
router.post('/audience/preview', handle((req) => campaigns.previewAudience(req.body?.audience || {})));
router.post('/campaigns/test', canSend, handle((req) => campaigns.sendTest(req.body || {}, adminId(req)), 'Test message sent'));
router.get('/campaigns', handle((req) => campaigns.listCampaigns({ page: req.query.page, limit: req.query.limit })));
router.post('/campaigns', canSend, handle((req) => campaigns.createCampaign(req.body || {}, adminId(req)), 'Campaign started'));
router.get('/campaigns/:id', handle((req) => campaigns.getCampaign(req.params.id)));
router.post('/campaigns/:id/cancel', canSend, handle((req) => campaigns.cancelCampaign(req.params.id), 'Campaign stopped'));
router.get('/report', handle((req) => campaigns.deliveryReport({ days: req.query.days })));

// Contacts (opt-in / opt-out)
router.get('/contacts', handle((req) => contacts.listContacts(req.query || {})));
router.post('/contacts', canSend, handle((req) => contacts.adminSetMarketing(req.body?.phone, req.body?.marketing, adminId(req)), 'Saved'));

// Order alerts
router.get('/notifications', handle(() => notifications.getNotificationSettings()));
router.put('/notifications', canSend, handle((req) => notifications.saveNotificationSettings(req.body || {}, adminId(req)), 'Saved'));

campaigns.startCampaignSender();

export default router;
