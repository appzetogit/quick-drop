import { ApiError } from '../../../utils/ApiError.js';

const SEGMENTS = ['foodAndQuick', 'taxiAndPorter'];

export function validateIncentiveRuleUpsertDto(body = {}) {
    const segment = String(body.segment || '').trim();
    if (!SEGMENTS.includes(segment)) {
        throw new ApiError(400, `segment must be one of: ${SEGMENTS.join(', ')}`);
    }

    const targetOrders = Number(body.targetOrders);
    if (!Number.isFinite(targetOrders) || targetOrders < 1) {
        throw new ApiError(400, 'targetOrders must be a number of at least 1');
    }

    const rewardAmount = Number(body.rewardAmount);
    if (!Number.isFinite(rewardAmount) || rewardAmount < 0) {
        throw new ApiError(400, 'rewardAmount must be a non-negative number');
    }

    return {
        segment,
        targetOrders: Math.round(targetOrders),
        rewardAmount: Math.round(rewardAmount * 100) / 100,
        title: String(body.title || '').trim(),
    };
}
