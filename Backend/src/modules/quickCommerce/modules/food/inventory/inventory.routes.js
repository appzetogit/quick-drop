import express from 'express';
import { sendResponse, sendError } from '../../../utils/response.js';
import * as inventory from './inventory.service.js';
import { importProducts } from './inventory.import.js';

/**
 * Admin > Quick Commerce > Inventory, mounted at /v1/qc/admin/inventory behind the
 * quick-commerce admin's own auth (admin.routes.js), next to /stock.
 *
 *   GET  /summary?section=&restaurantId=          the dashboard
 *   GET  /report?section=&restaurantId=&days=      sales, purchases, wastage, stock value
 *   GET  /suppliers        POST /suppliers        PATCH /suppliers/:id
 *   GET  /purchases?section=&restaurantId=        POST /purchases  (one vendor bill)
 *   POST /wastage                                 { itemId, variantId?, qty, reason, note? }
 *   GET  /fresh-sheet?restaurantId=               POST /fresh-sheet  { rows: [...] }
 *   POST /prices                                  { rows: [{itemId, variantId?}], field, mode, value }
 *   POST /products/:id/duplicate
 *   POST /import                                  { restaurantId, rows, dryRun } (Excel import and Quick add)
 */
export function inventoryRouter() {
  const router = express.Router();

  const actorOf = (req) => ({
    role: 'admin',
    id: String(req.user?.userId || req.user?.id || ''),
    name: req.user?.name || 'Admin',
  });

  const handle = (fn, message = 'OK') => async (req, res) => {
    try {
      return sendResponse(res, 200, message, await fn(req));
    } catch (err) {
      const status = err?.statusCode || err?.status || (err?.name === 'ValidationError' ? 400 : 500);
      return sendError(res, status, status >= 500 ? 'Could not complete this. Please try again.' : err.message);
    }
  };

  router.get('/summary', handle((req) => inventory.inventorySummary(req.query || {})));
  router.get('/report', handle((req) => inventory.inventoryReport(req.query || {})));

  router.get('/suppliers', handle((req) => inventory.listSuppliers(req.query || {})));
  router.post('/suppliers', handle((req) => inventory.saveSupplier(req.body || {}), 'Supplier added'));
  router.patch('/suppliers/:id', handle((req) => inventory.saveSupplier(req.body || {}, req.params.id), 'Supplier saved'));

  router.get('/purchases', handle((req) => inventory.listPurchases(req.query || {})));
  router.post('/purchases', handle((req) => inventory.createPurchase(req.body || {}, actorOf(req)), 'Purchase saved and stock added'));

  router.post('/wastage', handle((req) => inventory.recordWastage(req.body || {}, actorOf(req)), 'Wastage recorded'));

  router.get('/fresh-sheet', handle((req) => inventory.freshSheet(req.query || {})));
  router.post('/fresh-sheet', handle((req) => inventory.saveFreshSheet(req.body || {}, actorOf(req)), 'Saved'));

  router.post('/prices', handle((req) => inventory.bulkUpdatePrices(req.body || {}), 'Prices updated'));
  router.post('/products/:id/duplicate', handle((req) => inventory.duplicateProduct(req.params.id), 'Product copied'));
  router.post('/import', express.json({ limit: '5mb' }), handle((req) => importProducts(req.body || {}, actorOf(req)), 'Done'));

  return router;
}
