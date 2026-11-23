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
export function inventoryRouter({ scope = 'admin' } = {}) {
  const router = express.Router();
  const seller = scope === 'restaurant';

  const actorOf = (req) => (seller
    ? { role: 'restaurant', id: String(req.user?.userId || ''), name: req.user?.name || 'Store' }
    : { role: 'admin', id: String(req.user?.userId || req.user?.id || ''), name: req.user?.name || 'Admin' });

  const handle = (fn, message = 'OK') => async (req, res) => {
    try {
      return sendResponse(res, 200, message, await fn(req));
    } catch (err) {
      const status = err?.statusCode || err?.status || (err?.name === 'ValidationError' ? 400 : 500);
      return sendError(res, status, status >= 500 ? 'Could not complete this. Please try again.' : err.message);
    }
  };

  /*
   * A store's own dashboard (mounted under /qc/restaurant/inventory behind the
   * store login): the same screens as the admin's, for that store only. The
   * store id always comes from the login, never the request, and every product
   * or supplier named in a request must be the store's own.
   *
   * Price changes and new products from here would skip approval (a store's
   * price change goes back to Pending on the product editor), so bulk prices,
   * copy and Excel import stay admin-only, and the fresh sheet saves stock and
   * availability but not the selling price.
   */
  const forbidden = (message) => (req, res) => sendError(res, 403, message);
  const storeOf = (req) => String(req.user?.userId || '');
  if (seller) {
    router.use((req, res, next) => {
      const store = storeOf(req);
      if (!store) return sendError(res, 401, 'Sign in again');
      req.query = { ...(req.query || {}), restaurantId: store };
      if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) req.body.restaurantId = store;
      return next();
    });
  }
  const ownItems = async (req, ids) => {
    if (!seller) return;
    const { FoodItem } = await import('../admin/models/food.model.js');
    const list = [...new Set(ids.filter(Boolean).map(String))];
    if (!list.length) return;
    const mongoose = (await import('mongoose')).default;
    if (list.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw Object.assign(new Error('Unknown product'), { statusCode: 400 });
    const mine = await FoodItem.countDocuments({ _id: { $in: list }, restaurantId: storeOf(req) });
    if (mine !== list.length) throw Object.assign(new Error('That product belongs to another store'), { statusCode: 403 });
  };
  const ownSupplier = async (req, supplierId) => {
    if (!seller || !supplierId) return;
    const { InventorySupplier } = await import('./inventory.models.js');
    const ok = await InventorySupplier.exists({ _id: supplierId, restaurantId: storeOf(req) }).catch(() => null);
    if (!ok) throw Object.assign(new Error('Pick one of your own suppliers'), { statusCode: 403 });
  };

  router.get('/summary', handle((req) => inventory.inventorySummary(req.query || {})));
  router.get('/report', handle((req) => inventory.inventoryReport(req.query || {})));

  router.get('/suppliers', handle((req) => inventory.listSuppliers({ ...(req.query || {}), ownOnly: seller })));
  router.post('/suppliers', handle((req) => inventory.saveSupplier(req.body || {}, null, { ownerStoreId: seller ? storeOf(req) : null }), 'Supplier added'));
  router.patch('/suppliers/:id', handle((req) => inventory.saveSupplier(req.body || {}, req.params.id, { ownerStoreId: seller ? storeOf(req) : null }), 'Supplier saved'));

  router.get('/purchases', handle((req) => inventory.listPurchases(req.query || {})));
  router.post('/purchases', handle(async (req) => {
    await ownSupplier(req, req.body?.supplierId);
    return inventory.createPurchase(req.body || {}, actorOf(req));
  }, 'Purchase saved and stock added'));

  router.post('/wastage', handle(async (req) => {
    await ownItems(req, [req.body?.itemId]);
    return inventory.recordWastage(req.body || {}, actorOf(req));
  }, 'Wastage recorded'));

  router.get('/fresh-sheet', handle((req) => inventory.freshSheet(req.query || {})));
  router.post('/fresh-sheet', handle(async (req) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    await ownItems(req, rows.map((r) => r?.itemId));
    const body = seller
      ? { ...req.body, rows: rows.map(({ price, ...rest }) => rest) }
      : req.body || {};
    return inventory.saveFreshSheet(body, actorOf(req));
  }, 'Saved'));

  if (seller) {
    router.post('/prices', forbidden('Price changes go through approval: change the price on the product itself.'));
    router.post('/products/:id/duplicate', forbidden('New products go through approval: add them from Menu.'));
    router.post('/import', forbidden('Excel import is done by the admin.'));
  } else {
    router.post('/prices', handle((req) => inventory.bulkUpdatePrices(req.body || {}), 'Prices updated'));
    router.post('/products/:id/duplicate', handle((req) => inventory.duplicateProduct(req.params.id), 'Product copied'));
    router.post('/import', express.json({ limit: '5mb' }), handle((req) => importProducts(req.body || {}, actorOf(req)), 'Done'));
  }

  return router;
}
