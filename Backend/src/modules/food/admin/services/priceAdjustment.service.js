import mongoose from 'mongoose';
import { FoodItem } from '../models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodPriceAdjustment } from '../models/priceAdjustment.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * A single adjustment may not wipe out more than 90% of a price or more than
 * quadruple it. A typo of "1000" instead of "10" would otherwise be a
 * catastrophic, item-by-item-to-undo mistake.
 */
const MIN_PERCENT = -90;
const MAX_PERCENT = 300;

/** Prices below this are treated as unset and left alone. */
const MIN_RESULT_PRICE = 0.01;

/**
 * authMiddleware puts the admin on the request as { userId, role } -- there is no
 * _id, no id and no name. Reading actor._id meant every adjustment recorded a null
 * author, so the one audit trail for a change that rewrites every price on the
 * platform was always blank. The name is not on the token, so it is looked up.
 */
const resolveActor = async (actor = {}) => {
    const id = actor?.userId || actor?._id || actor?.id || null;
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
        return { appliedBy: null, appliedByName: '' };
    }
    const { FoodAdmin } = await import('../../../../core/admin/admin.model.js');
    const admin = await FoodAdmin.findById(id).select('name email').lean();
    return {
        appliedBy: id,
        appliedByName: admin?.name || admin?.email || ''
    };
};

const buildFilter = (restaurantId) => {
    const filter = {};
    if (restaurantId) filter.restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
    return filter;
};

const resolveRestaurant = async (restaurantId) => {
    if (!restaurantId) return { restaurantId: null, restaurantName: 'All restaurants' };
    if (!mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Invalid restaurant');
    }
    const restaurant = await FoodRestaurant.findById(restaurantId).select('restaurantName').lean();
    if (!restaurant?._id) throw new ValidationError('Restaurant not found');
    return {
        restaurantId: restaurant._id,
        restaurantName: restaurant.restaurantName || 'Unnamed restaurant'
    };
};

/**
 * Multiplies `price` and every variant price by `factor` in one pass.
 *
 * `$max` against MIN_RESULT_PRICE keeps a steep cut from writing a zero or
 * negative price, which the FoodItem schema would reject on the next save and
 * which checkout would happily charge as ₹0.
 */
const scalePriceExpr = (field, factor) => ({
    $max: [MIN_RESULT_PRICE, { $round: [{ $multiply: [`$${field}`, factor] }, 2] }]
});

const applyFactorToMenu = async (filter, factor) => {
    const result = await FoodItem.updateMany(filter, [
        {
            $set: {
                price: scalePriceExpr('price', factor),
                variants: {
                    $map: {
                        input: { $ifNull: ['$variants', []] },
                        as: 'variant',
                        in: {
                            $mergeObjects: [
                                '$$variant',
                                {
                                    price: {
                                        $max: [
                                            MIN_RESULT_PRICE,
                                            { $round: [{ $multiply: ['$$variant.price', factor] }, 2] }
                                        ]
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        }
    ]);
    return result?.modifiedCount || 0;
};

export async function listPriceAdjustments({ limit = 20 } = {}) {
    const capped = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const adjustments = await FoodPriceAdjustment.find({})
        .sort({ createdAt: -1 })
        .limit(capped)
        .lean();
    return { adjustments };
}

export async function getPriceAdjustmentPreview({ restaurantId } = {}) {
    const { restaurantName } = await resolveRestaurant(restaurantId);
    const itemCount = await FoodItem.countDocuments(buildFilter(restaurantId));
    return { itemCount, restaurantName };
}

export async function applyPriceAdjustment(body = {}, actor = {}) {
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent === 0) {
        throw new ValidationError('Enter a percent other than 0');
    }
    if (percent < MIN_PERCENT || percent > MAX_PERCENT) {
        throw new ValidationError(`Percent must be between ${MIN_PERCENT} and ${MAX_PERCENT}`);
    }

    const { restaurantId, restaurantName } = await resolveRestaurant(body.restaurantId);
    const factor = 1 + percent / 100;
    const itemsUpdated = await applyFactorToMenu(buildFilter(restaurantId), factor);

    const adjustment = await FoodPriceAdjustment.create({
        percent,
        factor,
        restaurantId,
        restaurantName,
        itemsUpdated,
        ...(await resolveActor(actor))
    });

    return { adjustment: adjustment.toObject(), itemsUpdated };
}

export async function revertPriceAdjustment(id, actor = {}) {
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
        throw new ValidationError('Invalid adjustment');
    }
    const original = await FoodPriceAdjustment.findById(id);
    if (!original) throw new ValidationError('Adjustment not found');
    if (original.isReverted) throw new ValidationError('This adjustment was already reverted');
    if (original.revertsAdjustmentId) throw new ValidationError('A revert cannot itself be reverted');

    const factor = Number(original.factor);
    if (!Number.isFinite(factor) || factor <= 0) {
        throw new ValidationError('This adjustment cannot be reverted automatically');
    }

    // ponytail: reverting divides by the original factor rather than restoring a
    // per-item snapshot, so a price can land a paisa off if it was not a clean
    // multiple (and any price clamped at MIN_RESULT_PRICE does not come back).
    // Snapshot every item's old price if exact restoration ever matters.
    const inverse = 1 / factor;
    const itemsUpdated = await applyFactorToMenu(buildFilter(original.restaurantId), inverse);

    original.isReverted = true;
    await original.save();

    const revertEntry = await FoodPriceAdjustment.create({
        percent: (inverse - 1) * 100,
        factor: inverse,
        restaurantId: original.restaurantId,
        restaurantName: original.restaurantName,
        itemsUpdated,
        revertsAdjustmentId: original._id,
        ...(await resolveActor(actor))
    });

    return { adjustment: revertEntry.toObject(), itemsUpdated };
}
