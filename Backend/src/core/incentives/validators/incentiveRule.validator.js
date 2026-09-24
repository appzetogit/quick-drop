import { ApiError } from '../../../utils/ApiError.js';

const SEGMENTS = ['foodAndQuick', 'taxiAndPorter'];
const MAX_TIERS = 12;

function validateTier(raw, index) {
    const fromOrders = Number(raw?.fromOrders);
    const toOrders = Number(raw?.toOrders);
    const rewardAmount = Number(raw?.rewardAmount);

    if (!Number.isFinite(fromOrders) || fromOrders < 1) {
        throw new ApiError(400, `Tier ${index + 1}: "from" must be a number of at least 1`);
    }
    if (!Number.isFinite(toOrders) || toOrders < fromOrders) {
        throw new ApiError(400, `Tier ${index + 1}: "to" must be a number at or above "from"`);
    }
    if (!Number.isFinite(rewardAmount) || rewardAmount < 0) {
        throw new ApiError(400, `Tier ${index + 1}: reward must be a non-negative number`);
    }

    return {
        fromOrders: Math.round(fromOrders),
        toOrders: Math.round(toOrders),
        rewardAmount: Math.round(rewardAmount * 100) / 100,
    };
}

export function validateIncentiveRuleUpsertDto(body = {}) {
    const segment = String(body.segment || '').trim();
    if (!SEGMENTS.includes(segment)) {
        throw new ApiError(400, `segment must be one of: ${SEGMENTS.join(', ')}`);
    }

    const rawTiers = Array.isArray(body.tiers) ? body.tiers : [];
    if (rawTiers.length === 0) {
        throw new ApiError(400, 'At least one tier is required, e.g. "1-5 orders → ₹100"');
    }
    if (rawTiers.length > MAX_TIERS) {
        throw new ApiError(400, `At most ${MAX_TIERS} tiers are allowed`);
    }

    const tiers = rawTiers.map(validateTier);

    // Ascending and strictly increasing by "to" — the crediting loop pays
    // every tier the rider has reached, in order, so two tiers unlocking at
    // the same order count would be ambiguous about which one "reaching 10
    // orders" actually means.
    for (let i = 1; i < tiers.length; i += 1) {
        if (tiers[i].toOrders <= tiers[i - 1].toOrders) {
            throw new ApiError(400, 'Tiers must be in order, each "to" higher than the one before it');
        }
    }

    return {
        segment,
        tiers,
        title: String(body.title || '').trim(),
    };
}
