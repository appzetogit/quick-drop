/**
 * Dish-level order quantity limits (minOrderQuantity / maxOrderQuantity) for
 * the admin food editor -- the same pair the restaurant's own item form has.
 *
 * The admin create/update and list paths never carried these: the editor had
 * the per-variant limits only, so a dish sold at one price could not be given
 * a minimum ("Rasgulla, at least 4") from admin at all. Validated with the
 * restaurant form's own rules (shared/orderQuantityRules.js) against the
 * platform ceiling from fee settings. 0 means "no minimum" / "no cap".
 */
import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';
import { FoodItem } from '../models/food.model.js';
import { normalizeOrderQuantityInput, assertOrderQuantityRange } from '../../shared/orderQuantityRules.js';
import { getOrderQuantityCeiling } from '../../shared/orderQuantityCeiling.js';

/** The list rows, each with its stored limits. One query for the page. */
export async function withFoodQuantityLimits(foods = []) {
    const ids = foods.map((f) => f?._id || f?.id).filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
    if (!ids.length) return foods;
    const rows = await FoodItem.find({ _id: { $in: ids } }).select('minOrderQuantity maxOrderQuantity').lean();
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    return foods.map((f) => {
        const r = byId.get(String(f?._id || f?.id));
        return r ? { ...f, minOrderQuantity: r.minOrderQuantity ?? 1, maxOrderQuantity: r.maxOrderQuantity ?? 0 } : f;
    });
}

/**
 * Checks the limits a create/update sends, before anything is written, so an
 * invalid pair never leaves a half-saved dish. Returns the values to store, or
 * undefined when the request sent neither field.
 */
export async function prepareFoodQuantityLimits(body = {}, { foodId = null } = {}) {
    const label = String(body.name || '').trim() || 'This dish';
    const limits = normalizeOrderQuantityInput(body, { label, ceiling: await getOrderQuantityCeiling() });
    if (!limits) return undefined;
    let existing = {};
    if (foodId) {
        existing = (await FoodItem.findById(foodId).select('minOrderQuantity maxOrderQuantity').lean()) || {};
    }
    assertOrderQuantityRange({ ...existing, ...limits }, { label });
    return limits;
}

export async function saveFoodQuantityLimits(foodId, limits) {
    if (!limits || !mongoose.Types.ObjectId.isValid(String(foodId))) return;
    const result = await FoodItem.updateOne({ _id: foodId }, { $set: limits });
    if (!result.matchedCount) throw new ValidationError('Food not found');
}
