import crypto from 'crypto';
import express from 'express';
import { whatsappCredentials } from '../settings/platformProfile.service.js';
import { processWhatsAppWebhook } from './whatsappInbox.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Meta WhatsApp Cloud API webhook: https://<domain>/api/v1/whatsapp/webhook
 *
 * Mounted in app.js AHEAD of the JSON parser, the sanitizers and the API rate
 * limiter, on purpose:
 *  - the signature is an HMAC of the exact bytes Meta sent, so the body is read
 *    raw here and parsed only after it checks out;
 *  - xss-clean would HTML-escape customers' messages ("<3" stored as "&lt;3");
 *  - Meta posts from a handful of addresses in bursts, and a rate-limited
 *    delivery is retried and then dropped.
 * Nothing in the body is trusted until the signature matches.
 */

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256(app secret, raw body), hex. */
export function validWhatsAppSignature(rawBody, header, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice(7), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

export default function whatsappWebhookRouter() {
  const router = express.Router();

  // Registration check: Meta sends hub.mode=subscribe, our verify token and a
  // challenge, and expects the challenge back as plain text.
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const { verifyToken } = whatsappCredentials();
    if (mode === 'subscribe' && verifyToken && sameToken(token, verifyToken) && typeof challenge === 'string') {
      logger.info('[WhatsApp] webhook verified by Meta');
      return res.status(200).type('text/plain').send(challenge);
    }
    logger.warn(`[WhatsApp] webhook verification refused (mode=${mode || 'none'}, token ${verifyToken ? 'mismatch' : 'not set'})`);
    return res.sendStatus(403);
  });

  router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    const { appSecret } = whatsappCredentials();
    if (!appSecret) {
      // Refused, not dropped: Meta retries for days, so nothing is lost while
      // the admin saves the app secret.
      logger.error('[WhatsApp] webhook POST refused: no app secret saved (Master settings > Payments & messages > WhatsApp)');
      return res.sendStatus(503);
    }
    if (!validWhatsAppSignature(req.body, req.get('x-hub-signature-256'), appSecret)) {
      logger.warn('[WhatsApp] webhook POST with a bad signature refused');
      return res.sendStatus(401);
    }
    let body;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    try {
      await processWhatsAppWebhook(body);
      return res.sendStatus(200);
    } catch (err) {
      // 500 so Meta delivers it again; stores are idempotent by message id.
      logger.error(`[WhatsApp] webhook processing failed: ${err.message}`);
      return res.sendStatus(500);
    }
  });

  return router;
}
