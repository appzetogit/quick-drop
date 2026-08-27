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
                addonIds: (entry?.addonIds || []).map((v) => String(v?._id ?? v?.id ?? v)).filter(Boolean),
                addons: (entry?.addons || []).map((pair) => ({
                    addonId: String(pair?.addonId ?? ''),
                    price: pair?.price ?? null,
                })).filter((pair) => pair.addonId)
            };
        })
        .filter(Boolean);

export const hasFoodVariants = (value = {}) => serializeFoodVariants(value?.variants || value?.variations || []).length > 0;

export const getFoodDisplayPrice = (value = {}) => {
    const variants = serializeFoodVariants(value?.variants || value?.variations || []);
    if (variants.length > 0) {
        return Math.min(...variants.map((entry) => Number(entry.price) || 0));
    }

    const price = Number(value?.price);
    return Number.isFinite(price) ? price : 0;
};
