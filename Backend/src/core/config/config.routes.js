import express from 'express';
import { requireFinancePermission } from '../admin/requireFinancePermission.middleware.js';
import {
    getCatalogueController,
    explainSettingController,
    resolveAllController,
    setSettingController,
    invalidateCacheController,
} from './config.controller.js';
import {
    getProfileController,
    updateProfileController,
    testRazorpayController,
    testEmailController,
    testSmsController,
} from '../settings/platformProfile.controller.js';
import { listAppLegal, saveAppLegal } from '../settings/appLegal.js';
import { getEarningsController } from '../finance/earnings.controller.js';

/**
 * Master / Global settings.
 *
 * Mounted under /v1/platform/settings rather than under a vertical, because that
 * is the whole point: these are the rules that apply everywhere, and putting them
 * beneath /food/admin would reproduce the problem they exist to solve.
 *
 * READS are open to any authenticated admin. WRITES need `settings.write`.
 * Deliberately asymmetric -- an operator who cannot change the cash limit should
 * still be able to see what it is and which level set it, or the first question
 * every support conversation starts with has no answer.
 */
const router = express.Router();

// Master settings: brand, contact, legal pages, integrations
// (core/settings/platformProfile.service.js). Declared before '/:key'.
router.get('/profile', getProfileController);
router.patch('/profile', requireFinancePermission('PLATFORM_SETTING_SET'), updateProfileController);
router.post('/profile/test/razorpay', requireFinancePermission('PLATFORM_SETTING_SET'), testRazorpayController);
router.post('/profile/test/email', requireFinancePermission('PLATFORM_SETTING_SET'), testEmailController);
router.post('/profile/test/sms', requireFinancePermission('PLATFORM_SETTING_SET'), testSmsController);

// Terms and privacy per app (core/settings/appLegal.js).
router.get('/app-legal', listAppLegal);
router.put('/app-legal/:app/:kind', requireFinancePermission('PLATFORM_SETTING_SET'), saveAppLegal);

// What a module pays its riders today, and its own bands to start an edit from
// (core/finance/earnings.controller.js). Declared before '/:key'.
router.get('/earnings/:vertical', getEarningsController);

router.get('/catalogue', getCatalogueController);
router.get('/resolve', resolveAllController);
router.get('/:key/explain', explainSettingController);

router.put('/:key', requireFinancePermission('PLATFORM_SETTING_SET'), setSettingController);
router.post('/cache/invalidate', requireFinancePermission('PLATFORM_SETTING_SET'), invalidateCacheController);

export default router;
