import { ValidationError } from '../../../core/auth/errors.js';

/**
 * Per-menu-item order quantity limits, set by the restaurant (or admin) on the item.
 *
 *   minOrderQuantity — smallest quantity a customer may order (default 1).
 *                      e.g. Rasgulla priced per piece with a minimum of 4.
 *   maxOrderQuantity — largest quantity per order; 0 means "no item-specific cap",
 *                      in which case the platform ceiling below applies.
 *
 * Enforced server-side at every write: cart add, cart update, cart hydrate, and
 * order creation. The UIs mirror these rules but are never the authority.
 */

export const DEFAULT_MIN_ORDER_QUANTITY = 1;
/** Platform ceiling; also the cart's hard per-line cap. */
export const ABSOLUTE_MAX_ORDER_QUANTITY = 99;

const toInt = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.floor(num) : NaN;
};

/**
 * Effective limits for a stored menu item.
 * `max` is always a usable number (the ceiling when the item sets no cap).
 */
/**
 * `ceiling` is the platform-wide cap, which an admin can now set under fee
 * settings (maxOrderQuantityCeiling). It defaults to the constant this module
 * has always used, so a caller that does not pass one behaves exactly as before
 * and an unset setting changes nothing.
 */
export const resolveCeiling = (ceiling) => {
    const value = toInt(ceiling);
    return Number.isFinite(value) && value > 0 ? value : ABSOLUTE_MAX_ORDER_QUANTITY;
};

export function resolveOrderQuantityRules(foodDoc = null, ceiling = ABSOLUTE_MAX_ORDER_QUANTITY) {
    const cap = resolveCeiling(ceiling);

    const rawMin = toInt(foodDoc?.minOrderQuantity);
    const min = Number.isFinite(rawMin) && rawMin > 0
        ? Math.min(rawMin, cap)
        : DEFAULT_MIN_ORDER_QUANTITY;

    const rawMax = toInt(foodDoc?.maxOrderQuantity);
    const hasCap = Number.isFinite(rawMax) && rawMax > 0;
    const max = hasCap
        ? Math.min(Math.max(rawMax, min), cap)
        : cap;

    // Carried on the result so assertOrderQuantity can enforce the platform cap
    // for items that set no cap of their own, without every caller having to
    // pass the ceiling twice.
    return { min, max, hasCap, ceiling: cap };
}

/** Stored shape to hand to clients (0 max = unlimited, so UIs can say so). */
export function formatOrderQuantityLimits(foodDoc = null, ceiling = ABSOLUTE_MAX_ORDER_QUANTITY) {
    const { min, max, hasCap } = resolveOrderQuantityRules(foodDoc, ceiling);
    return {
        minOrderQuantity: min,
        maxOrderQuantity: hasCap ? max : 0
    };
}

/** Pull a quantity into range. Used when limits change under an existing cart. */
export function clampOrderQuantity(quantity, rules) {
    const { min, max } = rules || resolveOrderQuantityRules(null);
    const qty = toInt(quantity);
    if (!Number.isFinite(qty)) return min;
    return Math.min(max, Math.max(min, qty));
}

/**
 * Hard gate for explicit writes (cart update, checkout). Throws a message the
 * customer can act on rather than silently changing what they asked for.
 */
export function assertOrderQuantity(quantity, rules, label = 'This item') {
    const { min, max, hasCap } = rules || resolveOrderQuantityRules(null);
    const qty = toInt(quantity);

    if (!Number.isFinite(qty) || qty <= 0) {
        throw new ValidationError(`Enter a valid quantity for "${label}"`);
    }
    if (qty < min) {
        throw new ValidationError(
            `"${label}" has a minimum order quantity of ${min}`,
            'MIN_ORDER_QUANTITY'
        );
    }
    if (hasCap && qty > max) {
        throw new ValidationError(
            `"${label}" has a maximum order quantity of ${max}`,
            'MAX_ORDER_QUANTITY'
        );
    }
    // The platform cap, which also covers items that set no cap of their own --
    // for those, hasCap is false and the check above never fires.
    const platformCap = resolveCeiling(rules?.ceiling);
    if (qty > platformCap) {
        throw new ValidationError(
            `"${label}" is limited to ${platformCap} per order`,
            'MAX_ORDER_QUANTITY'
        );
    }
    return qty;
}

/**
 * Menu-item form input (restaurant/admin). Returns undefined for each field the
 * caller didn't send, so partial updates never reset a stored limit.
 */
export function normalizeOrderQuantityInput(body = {}, { label = 'This item', ceiling = ABSOLUTE_MAX_ORDER_QUANTITY } = {}) {
    const update = {};
    const cap = resolveCeiling(ceiling);

    if (body.minOrderQuantity !== undefined && body.minOrderQuantity !== null && body.minOrderQuantity !== '') {
        const min = toInt(body.minOrderQuantity);
        if (!Number.isFinite(min) || min < 1) {
            throw new ValidationError(`Minimum order quantity for "${label}" must be at least 1`);
        }
        if (min > cap) {
            throw new ValidationError(
                `Minimum order quantity for "${label}" cannot exceed ${cap}`
            );
        }
        update.minOrderQuantity = min;
    } else if (body.minOrderQuantity === null || body.minOrderQuantity === '') {
        update.minOrderQuantity = DEFAULT_MIN_ORDER_QUANTITY;
    }

    if (body.maxOrderQuantity !== undefined && body.maxOrderQuantity !== null && body.maxOrderQuantity !== '') {
        const max = toInt(body.maxOrderQuantity);
        if (!Number.isFinite(max) || max < 0) {
            throw new ValidationError(`Maximum order quantity for "${label}" must be 0 or more`);
        }
        if (max > cap) {
            throw new ValidationError(
                `Maximum order quantity for "${label}" cannot exceed ${cap}`
            );
        }
        update.maxOrderQuantity = max;
    } else if (body.maxOrderQuantity === null || body.maxOrderQuantity === '') {
        update.maxOrderQuantity = 0;
    }

    return Object.keys(update).length ? update : undefined;
}

/**
 * Cross-field check against the values that will actually be stored (incoming
 * merged over existing), so "max below min" can't slip through a partial update.
 */
export function assertOrderQuantityRange(nextValues = {}, { label = 'This item' } = {}) {
    const min = toInt(nextValues.minOrderQuantity) || DEFAULT_MIN_ORDER_QUANTITY;
    const max = toInt(nextValues.maxOrderQuantity) || 0;
    if (max > 0 && max < min) {
        throw new ValidationError(
            `Maximum order quantity for "${label}" must be greater than or equal to the minimum (${min})`
        );
    }
}
