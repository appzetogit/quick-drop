import express from 'express';
import { requireFinancePermission } from '../admin/requireFinancePermission.middleware.js';
import {
    getCatalogueController,
    explainSettingController,
    resolveAllController,
    setSettingController,
    invalidateCacheController,
} from './config.controller.js';

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

router.get('/catalogue', getCatalogueController);
router.get('/resolve', resolveAllController);
router.get('/:key/explain', explainSettingController);

router.put('/:key', requireFinancePermission('PLATFORM_SETTING_SET'), setSettingController);
router.post('/cache/invalidate', requireFinancePermission('PLATFORM_SETTING_SET'), invalidateCacheController);

export default router;
