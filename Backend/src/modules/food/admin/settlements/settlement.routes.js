import express from 'express';
import { sendResponse, sendError } from '../../../../utils/response.js';
import { requireFinancePermission } from '../../../../core/admin/requireFinancePermission.middleware.js';
import * as settlements from './settlement.service.js';

/**
 * Admin > Food > Restaurant settlement, mounted at /v1/food/admin/settlements
 * behind the food admin's auth and the 'wallet' section permission.
 *
 *   GET  /restaurants                     restaurant dropdown
 *   GET  /officers                        payment officer dropdown
 *   GET  /overview?year=&month=&cycle=    every restaurant in a cycle
 *   GET  /cycle?restaurantId=&year=&month=&cycle=
 *   GET  /history?restaurantId=           earlier settlements and payments
 *   POST /pay                             Clear Payment (locks the cycle's bills)
 *   POST /hold                            { hold: true|false, note }
 */
export function settlementRouter() {
  const router = express.Router();
  const actorOf = (req) => ({ id: String(req.user?.userId || req.user?.id || ''), name: req.user?.name || req.user?.email || 'Admin' });
  const handle = (fn, message = 'OK') => async (req, res) => {
    try {
      return sendResponse(res, 200, message, await fn(req));
    } catch (err) {
      const status = err?.statusCode || err?.status || (err?.name === 'ValidationError' ? 400 : 500);
      return sendError(res, status, status >= 500 ? 'Could not complete this. Please try again.' : err.message);
    }
  };

  router.get('/restaurants', handle(() => settlements.listRestaurants()));
  router.get('/officers', handle(() => settlements.listOfficers()));
  router.get('/overview', handle((req) => settlements.cycleOverview(req.query || {})));
  router.get('/cycle', handle((req) => settlements.getCycle(req.query || {})));
  router.get('/history', handle((req) => settlements.settlementHistory(req.query || {})));
  router.post('/pay', requireFinancePermission('WITHDRAWAL_DECIDE'), handle((req) => settlements.recordPayment(req.body || {}, actorOf(req)), 'Payment recorded'));
  router.post('/hold', requireFinancePermission('WITHDRAWAL_DECIDE'), handle((req) => settlements.setHold(req.body || {}, actorOf(req)), 'Saved'));
  return router;
}
