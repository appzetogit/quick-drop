import express from 'express';
import { requireAnyAdminPermission } from '../../../../core/roles/adminPermission.middleware.js';
import {
    getMedicalSettingsController,
    listMedicalRequestsController,
    updateMedicalSettingsController,
} from '../controllers/medicalAdmin.controller.js';

/**
 * The platform's medical rules and the broadcast log, for the Medical panel.
 *
 * The range is the one setting on this router that changes what customers see:
 * it decides both which pharmacies a customer is shown and which ones a
 * prescription is sent to. Writing it therefore asks for an edit permission,
 * while the request log -- a record of who was offered what -- asks only to view.
 *
 * Mounted rather than declared in admin.routes.js so the admin guard, the
 * adminAccess hydration and the section resolver in that file all still run.
 */
const router = express.Router();

const canViewSettings = requireAnyAdminPermission([
    { section: 'restaurant_management', action: 'view' },
    { section: 'order_management', action: 'view' },
    { section: 'report_management', action: 'view' },
]);

const canEditSettings = requireAnyAdminPermission([
    { section: 'restaurant_management', action: 'edit' },
]);

router.get('/settings', canViewSettings, getMedicalSettingsController);
router.put('/settings', canEditSettings, updateMedicalSettingsController);
router.get('/requests', canViewSettings, listMedicalRequestsController);

export default router;
