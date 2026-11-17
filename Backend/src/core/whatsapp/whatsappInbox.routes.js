import express from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { requireRoles } from '../roles/role.middleware.js';
import { requireFinancePermission } from '../admin/requireFinancePermission.middleware.js';
import { sendResponse, sendError } from '../../utils/response.js';
import { whatsappCredentials } from '../settings/platformProfile.service.js';
import * as inbox from './whatsappInbox.service.js';

/**
 * Master > WhatsApp: /v1/platform/whatsapp. Reading needs an admin login;
 * replying to a customer needs the same permission as changing a platform
 * setting, since it speaks for the whole business.
 */
const router = express.Router();

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
    return sendError(res, status, status >= 500 ? 'Could not complete that. Please try again.' : err.message);
  }
};
const adminId = (req) => String(req.financeActor?.adminId || req.user?.userId || req.user?.id || '');

router.get('/status', handle(async () => {
  const c = whatsappCredentials();
  return {
    sending: Boolean(c.accessToken && c.phoneNumberId),
    phoneNumberId: c.phoneNumberId,
    appSecretSet: Boolean(c.appSecret),
    verifyTokenSet: Boolean(c.verifyToken),
    callbackPath: '/api/v1/whatsapp/webhook',
    unread: await inbox.unreadCount(),
    ...(await inbox.lastWebhookActivity()),
  };
}));
router.get('/conversations', handle((req) => inbox.listConversations({ search: req.query.search, limit: req.query.limit })));
router.get('/conversations/:phone', handle((req) => inbox.getConversation(req.params.phone)));
router.post(
  '/conversations/:phone/reply',
  requireFinancePermission('PLATFORM_SETTING_SET'),
  handle((req) => inbox.replyToConversation(req.params.phone, req.body?.text, adminId(req)), 'Sent'),
);

export default router;
