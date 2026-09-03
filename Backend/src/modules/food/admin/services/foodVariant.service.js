import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';

const toTrimmedString = (value) => (value == null ? '' : String(value).trim());

export const extractRawFoodVariants = (value = {}) => {
    if (Array.isArray(value?.variants)) return value.variants;
    if (Array.isArray(value?.variations)) return value.variations;
    return [];
};

export const normalizeFoodVariantsInput = (value = [], options = {}) => {
    const {
        allowEmpty = true,
        priceLabel = 'Variant price'
    } = options;

    if (value == null || value === '') {
        if (allowEmpty) return [];
        throw new ValidationError('At least one variant is required');
    }

    if (!Array.isArray(value)) {
        throw new ValidationError('Variants must be an array');
    }

    const normalized = value
        .map((entry = {}) => {
            const name = toTrimmedString(entry?.name);
            if (!name) {
                throw new ValidationError('Each variant must have a name');
            }

            const price = Number(entry?.price);
            if (!Number.isFinite(price) || price <= 0) {
                throw new ValidationError(`${priceLabel} must be greater than 0`);
            }

            const variant = {
                name,
                price
            };

            // Optional per-size quantity limits. Absent or blank means "not set",
            // which is different from zero: the dish's own limit then applies.
            // Send null explicitly to clear one.
            if (entry?.minOrderQuantity !== undefined) {
                const raw = entry.minOrderQuantity;
                if (raw === null || raw === '') variant.minOrderQuantity = null;
                else {
                    const min = Math.floor(Number(raw));
                    if (!Number.isFinite(min) || min < 1) {
                        throw new ValidationError(`Minimum quantity for "${name}" must be 1 or more`);
                    }
                    variant.minOrderQuantity = min;
                }
            }
            if (entry?.maxOrderQuantity !== undefined) {
                const raw = entry.maxOrderQuantity;
                if (raw === null || raw === '') variant.maxOrderQuantity = null;
                else {
                    const max = Math.floor(Number(raw));
                    // 0 keeps the meaning it has everywhere else here: no cap of
                    // its own, so the platform ceiling applies.
                    if (!Number.isFinite(max) || max < 0) {
                        throw new ValidationError(`Maximum quantity for "${name}" must be 0 or more`);
                    }
                    variant.maxOrderQuantity = max;
                }
            }
            if (
                variant.minOrderQuantity != null
                && variant.maxOrderQuantity != null
                && variant.maxOrderQuantity > 0
                && variant.maxOrderQuantity < variant.minOrderQuantity
            ) {
                throw new ValidationError(`Maximum quantity for "${name}" cannot be below its minimum`);
            }

            // Per-variant add-ons, each pairing optionally carrying its own price
            // for this size. Two accepted shapes:
            //   addons:   [{ addonId, price }]  -- price null means "the add-on's own"
            //   addonIds: [id, ...]             -- older callers; every price null
            // Only carried when the caller sent one of the keys, so a form that
            // does not know about them leaves the stored pairings alone rather
            // than clearing them. addonIds is always rewritten from the pairings,
            // so the two can never disagree about which add-ons are allowed.
            if (entry?.addons !== undefined || entry?.addonIds !== undefined) {
                const rawPairs = entry?.addons !== undefined
                    ? (Array.isArray(entry.addons) ? entry.addons : [entry.addons])
                    : (Array.isArray(entry.addonIds) ? entry.addonIds : [entry.addonIds])
                        .map((v) => ({ addonId: v, price: null }));

                const seen = new Set();
                const pairs = [];
                for (const pair of rawPairs) {
                    const rawId = pair && typeof pair === 'object'
                        ? (pair.addonId ?? pair._id ?? pair.id ?? '')
                        : pair;
                    const id = String(
                        rawId && typeof rawId === 'object' ? (rawId._id ?? rawId.id ?? '') : (rawId ?? '')
                    ).trim();
                    if (!id) continue;
                    if (!mongoose.Types.ObjectId.isValid(id)) {
                        throw new ValidationError(`One or more add-ons selected for "${name}" are not valid`);
                    }
                    if (seen.has(id)) continue;
                    seen.add(id);

                    let pairPrice = null;
                    const rawPrice = pair && typeof pair === 'object' ? pair.price : undefined;
                    if (rawPrice !== undefined && rawPrice !== null && rawPrice !== '') {
                        pairPrice = Number(rawPrice);
                        if (!Number.isFinite(pairPrice) || pairPrice < 0) {
                            throw new ValidationError(`Add-on price for "${name}" must be a number of 0 or more`);
                        }
                        pairPrice = Math.round(pairPrice * 100) / 100;
                    }

                    pairs.push({ addonId: new mongoose.Types.ObjectId(id), price: pairPrice });
                }

                variant.addons = pairs;
                variant.addonIds = pairs.map((pair) => pair.addonId);
            }

            const variantId = entry?._id || entry?.id;
            if (variantId && mongoose.Types.ObjectId.isValid(String(variantId))) {
                variant._id = new mongoose.Types.ObjectId(String(variantId));
            }

            return variant;
        })
        .filter(Boolean);

    if (!allowEmpty && normalized.length === 0) {
        throw new ValidationError('At least one variant is required');
    }

    return normalized;
};

export const serializeFoodVariants = (value = []) =>
    (Array.isArray(value) ? value : [])
        .map((entry = {}) => {
            const name = toTrimmedString(entry?.name);
            const price = Number(entry?.price);
            if (!name || !Number.isFinite(price) || price <= 0) return null;

            const variantId = entry?._id || entry?.id;
            return {
                id: variantId ? String(variantId) : '',
                _id: variantId ? String(variantId) : '',
                name,
                price,
                // null means this size sets none of its own; the dish's applies.
                minOrderQuantity: entry?.minOrderQuantity ?? null,
                maxOrderQuantity: entry?.maxOrderQuantity ?? null,
                addonIds: (entry?.addonIds || []).map((v) => String(v?._id ?? v?.id ?? v)).filter(Boolean),
                addons: (entry?.addons || []).map((pair) => ({
                    addonId: String(pair?.addonId ?? ''),
                    price: pair?.price ?? null,
                })).filter((pair) => pair.addonId)
            };
        })
        .filter(Boolean);

export const hasFoodVariants = (value = {}) => serializeFoodVariants(value?.variants || value?.variations || []).length > 0;

/**
 * Is this dish actually SOLD by its variants right now?
 *
 * The toggle beats the array: variants switched off stay stored (so switching
 * back on costs nothing) but must not drive pricing or show a size picker.
 * Rows written before the flag have it undefined, which is NOT off -- for
 * them, having variants means selling by variants, as it always did.
 */
export const sellsByVariants = (value = {}) =>
    value?.variantsEnabled !== false && hasFoodVariants(value);

export const getFoodDisplayPrice = (value = {}) => {
    const variants = serializeFoodVariants(value?.variants || value?.variations || []);
    // A doc with variants switched off prices from its own price field; only a
    // bare {variants} shape (the write paths computing a "from" figure) or a
    // doc actually selling by variants reads the array.
    if (value?.variantsEnabled === false) {
        const own = Number(value?.price);
        if (Number.isFinite(own) && own > 0) return own;
    }
    if (variants.length > 0) {
        return Math.min(...variants.map((entry) => Number(entry.price) || 0));
    }

    const price = Number(value?.price);
    return Number.isFinite(price) ? price : 0;
};
