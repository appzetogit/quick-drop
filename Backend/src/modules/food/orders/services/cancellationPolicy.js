import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * How long a customer may cancel a food order after the restaurant accepts it.
 *
 * Before this, a customer could cancel only while the order was waiting for the
 * restaurant ('created'); the moment it was accepted the option was gone. The
 * admin can now open a short window after acceptance (Food panel -> Order
 * cancellation). Off by default, so nothing changes until an admin turns it on.
 *
 * Never once the rider has the food: that rule lives in the status update path
 * and is repeated here, because the rider would go unpaid for the trip.
 */

const rulesSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    allowAfterAccept: { type: Boolean, default: false },
    /** Minutes after the restaurant accepted. */
    windowMinutes: { type: Number, default: 5, min: 1, max: 120 },
    /** Stop as soon as the kitchen marks it Preparing, even inside the window. */
    stopWhenPreparing: { type: Boolean, default: true },
    updatedBy: { type: String, default: '' },
  },
  { collection: 'food_order_cancel_rules', timestamps: true },
);

export const FoodOrderCancelRules = mongoose.models.FoodOrderCancelRules
  || mongoose.model('FoodOrderCancelRules', rulesSchema);

const DEFAULTS = { allowAfterAccept: false, windowMinutes: 5, stopWhenPreparing: true };
const TTL_MS = 30_000;
let cache = null;

export async function getCancelRules() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rules;
  const doc = await FoodOrderCancelRules.findOne({ key: 'default' }).lean();
  const rules = {
    allowAfterAccept: doc?.allowAfterAccept ?? DEFAULTS.allowAfterAccept,
    windowMinutes: doc?.windowMinutes ?? DEFAULTS.windowMinutes,
    stopWhenPreparing: doc?.stopWhenPreparing ?? DEFAULTS.stopWhenPreparing,
    updatedAt: doc?.updatedAt || null,
  };
  cache = { at: Date.now(), rules };
  return rules;
}

export async function setCancelRules(body = {}, actorId = '') {
  const set = {};
  if (body.allowAfterAccept !== undefined) set.allowAfterAccept = body.allowAfterAccept === true;
  if (body.stopWhenPreparing !== undefined) set.stopWhenPreparing = body.stopWhenPreparing === true;
  if (body.windowMinutes !== undefined) {
    const n = Math.floor(Number(body.windowMinutes));
    if (!Number.isFinite(n) || n < 1 || n > 120) throw new ValidationError('Choose between 1 and 120 minutes');
    set.windowMinutes = n;
  }
  set.updatedBy = String(actorId || '');
  await FoodOrderCancelRules.updateOne({ key: 'default' }, { $set: set, $setOnInsert: { key: 'default' } }, { upsert: true });
  cache = null;
  return getCancelRules();
}

export const clearCancelRulesCache = () => { cache = null; };

/** When the restaurant accepted: the last move into 'confirmed'. */
export function acceptedAtOf(order) {
  const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.to === 'confirmed' && history[i]?.at) return new Date(history[i].at);
  }
  return null;
}

const riderHasTheFood = (order) =>
  ['picked_up', 'reached_drop', 'delivered'].includes(order?.orderStatus)
  || ['en_route_to_delivery', 'at_drop'].includes(order?.deliveryState?.currentPhase);

/**
 * Can this customer cancel this order now?
 *   { allowed, until, reason }  -- `until` is when the window closes (null if
 *   there is no deadline, i.e. still waiting for the restaurant).
 */
export function judgeUserCancel(order, rules, now = new Date()) {
  const status = String(order?.orderStatus || '');
  if (status === 'created') return { allowed: true, until: null, reason: '' };
  if (status.startsWith('cancelled')) return { allowed: false, until: null, reason: 'This order is already cancelled' };
  if (riderHasTheFood(order)) {
    return { allowed: false, until: null, reason: 'This order has been picked up and can no longer be cancelled' };
  }
  if (!rules?.allowAfterAccept) {
    return { allowed: false, until: null, reason: 'This order can no longer be cancelled: the restaurant has accepted it' };
  }
  const open = rules.stopWhenPreparing ? ['confirmed'] : ['confirmed', 'preparing'];
  if (!open.includes(status)) {
    return {
      allowed: false,
      until: null,
      reason: status === 'preparing'
        ? 'This order can no longer be cancelled: the restaurant has started preparing it'
        : 'This order can no longer be cancelled',
    };
  }
  const accepted = acceptedAtOf(order) || (order?.updatedAt ? new Date(order.updatedAt) : null);
  if (!accepted) return { allowed: false, until: null, reason: 'This order can no longer be cancelled' };
  const until = new Date(accepted.getTime() + Number(rules.windowMinutes) * 60_000);
  if (now > until) {
    return {
      allowed: false,
      until,
      reason: `This order can no longer be cancelled: the restaurant accepted it more than ${rules.windowMinutes} minute${Number(rules.windowMinutes) === 1 ? '' : 's'} ago`,
    };
  }
  return { allowed: true, until, reason: '' };
}

/** What the customer app shows: can cancel, until when, seconds left. */
export function cancellationForClient(order, rules, now = new Date()) {
  const verdict = judgeUserCancel(order, rules, now);
  return {
    allowed: verdict.allowed,
    until: verdict.until ? verdict.until.toISOString() : null,
    secondsLeft: verdict.allowed && verdict.until ? Math.max(0, Math.floor((verdict.until - now) / 1000)) : null,
    reason: verdict.reason,
  };
}
