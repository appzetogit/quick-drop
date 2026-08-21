import express from 'express';
import { authMiddleware } from '../../../../core/auth/auth.middleware.js';
import { requireRoles } from '../../../../core/roles/role.middleware.js';
import * as ctrl from '../controllers/return.controller.js';

/**
 * Quick-commerce returns.
 *
 * Three audiences on one router, each gated by role at the route rather than in a
 * controller: a customer files and tracks, an admin decides and pays, a rider
 * collects. Mounted at /v1/qc/returns.
 */
const router = express.Router();

// ── Admin ──────────────────────────────────────────────────────────────────────
// Registered before the customer's `/:returnId` routes so `/admin` is never
// swallowed as a return id.
router.get('/admin', authMiddleware, requireRoles('ADMIN'), ctrl.listReturnsAdminController);
router.patch('/admin/:returnId/decision', authMiddleware, requireRoles('ADMIN'), ctrl.decideReturnAdminController);
router.patch('/admin/:returnId/pickup', authMiddleware, requireRoles('ADMIN'), ctrl.schedulePickupAdminController);
router.patch('/admin/:returnId/inspect', authMiddleware, requireRoles('ADMIN'), ctrl.inspectReturnAdminController);
router.patch('/admin/:returnId/refund', authMiddleware, requireRoles('ADMIN'), ctrl.refundReturnAdminController);

// ── Delivery partner ───────────────────────────────────────────────────────────
router.patch(
    '/partner/:returnId/collected',
    authMiddleware,
    requireRoles('DELIVERY_PARTNER'),
    ctrl.markPickedUpController,
);

// ── Customer ───────────────────────────────────────────────────────────────────
router.get('/orders/:orderId/returnable', authMiddleware, requireRoles('USER'), ctrl.getReturnableItemsController);
router.post('/orders/:orderId', authMiddleware, requireRoles('USER'), ctrl.requestReturnController);
router.get('/', authMiddleware, requireRoles('USER'), ctrl.listMyReturnsController);
router.get('/:returnId', authMiddleware, requireRoles('USER'), ctrl.getMyReturnController);
router.patch('/:returnId/cancel', authMiddleware, requireRoles('USER'), ctrl.cancelMyReturnController);

export default router;
