import ms from 'ms';
import { config } from '../../config/env.js';
import { signRefreshToken } from './token.util.js';
import { logger } from '../../utils/logger.js';

/**
 * Sliding sessions: a refresh token in use is replaced before it runs out.
 *
 * Refresh tokens used to live a fixed 30 days from sign-in (JWT_REFRESH_EXPIRES)
 * and were never renewed, so every rider, store and customer was signed out on
 * day 30 however much they used the app -- "logged out out of the blue". Now a
 * refresh made in the second half of a token's life also returns a NEW refresh
 * token, good for a full term from today, and the clients store it.
 *
 * The old token is not deleted: it is cut to a short grace period. Two requests
 * refreshing at once, or a reply lost on a bad connection, then still find a
 * working token instead of a dead one; after the grace period it lapses.
 */
const GRACE_MS = 2 * 24 * 60 * 60 * 1000;
const JWT_CLAIMS = new Set(['iat', 'exp', 'nbf', 'jti']);

/**
 * @param {object} args
 * @param {import('mongoose').Model} args.Model   the refresh-token collection that holds `stored`
 * @param {object} args.stored                    the stored refresh-token row (lean)
 * @param {object} args.payload                   the verified refresh JWT payload
 * @returns {Promise<string|null>} the new refresh token, or null to keep the presented one
 */
export async function renewRefreshTokenIfAging({ Model, stored, payload }) {
  try {
    const ttl = ms(config.jwtRefreshExpiresIn || '7d');
    const expMs = Number(payload?.exp) * 1000;
    if (!ttl || !Number.isFinite(expMs) || expMs - Date.now() > ttl / 2) return null;

    const claims = Object.fromEntries(Object.entries(payload).filter(([k]) => !JWT_CLAIMS.has(k)));
    const token = signRefreshToken(claims);
    await Model.create({
      userId: stored.userId,
      token,
      device: stored.device ?? null,
      ipAddress: stored.ipAddress ?? null,
      expiresAt: new Date(Date.now() + ttl),
    });
    const graceEnd = new Date(Date.now() + GRACE_MS);
    await Model.updateOne({ _id: stored._id, expiresAt: { $gt: graceEnd } }, { $set: { expiresAt: graceEnd } });
    return token;
  } catch (err) {
    // Not renewing is safe: the presented token still works until its own expiry.
    logger.warn(`refresh token renewal skipped: ${err.message}`);
    return null;
  }
}
