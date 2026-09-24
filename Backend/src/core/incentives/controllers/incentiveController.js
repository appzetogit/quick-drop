import { DriverIncentiveRule } from '../models/driverIncentiveRule.model.js';
import { getCurrentIncentiveForFoodPartner, tiersOfRule } from '../services/incentiveService.js';
import { validateIncentiveRuleUpsertDto } from '../validators/incentiveRule.validator.js';
import { sendResponse, sendError } from '../../../utils/response.js';

/** GET /food/delivery/incentives/current — rider-facing. */
export async function getCurrentIncentiveController(req, res, next) {
    try {
        const data = await getCurrentIncentiveForFoodPartner(req.user?.userId);
        return sendResponse(res, 200, 'Incentive progress fetched', data);
    } catch (error) {
        next(error);
    }
}

/** GET /food/admin/incentive-rules — the master-panel "Delivery Incentives" list. */
export async function listIncentiveRulesController(req, res, next) {
    try {
        const active = await DriverIncentiveRule.find({ isActive: true }).sort({ segment: 1 }).lean();
        const recent = await DriverIncentiveRule.find({}).sort({ createdAt: -1 }).limit(20).lean();
        // Rules saved before tiers existed are shown as their one-rung ladder.
        const withTiers = (r) => ({ ...r, tiers: tiersOfRule(r) });
        return sendResponse(res, 200, 'Incentive rules fetched', { active: active.map(withTiers), recent: recent.map(withTiers) });
    } catch (error) {
        next(error);
    }
}

/**
 * PUT /food/admin/incentive-rules — sets the active rule for one segment.
 * Deactivates whatever was active for that segment first, so a segment never
 * has two rules answering "what's current" at once; the previous rule is
 * kept, not deleted, as history.
 */
export async function upsertIncentiveRuleController(req, res, next) {
    try {
        const body = validateIncentiveRuleUpsertDto(req.body || {});
        await DriverIncentiveRule.updateMany(
            { segment: body.segment, isActive: true },
            { $set: { isActive: false } },
        );
        const created = await DriverIncentiveRule.create({ ...body, createdByAdminId: req.user?._id || null });
        return sendResponse(res, 201, 'Incentive rule saved', created);
    } catch (error) {
        next(error);
    }
}

/** DELETE /food/admin/incentive-rules/:id — turns a rule off without deleting its history. */
export async function deactivateIncentiveRuleController(req, res, next) {
    try {
        const updated = await DriverIncentiveRule.findByIdAndUpdate(
            req.params.id,
            { $set: { isActive: false } },
            { new: true },
        );
        if (!updated) return sendError(res, 404, 'Incentive rule not found');
        return sendResponse(res, 200, 'Incentive rule deactivated', updated);
    } catch (error) {
        next(error);
    }
}
