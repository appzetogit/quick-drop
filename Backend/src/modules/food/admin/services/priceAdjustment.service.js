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
/**
 * Scale one price, then hold it at the item's MRP.
 *
 * This runs as an aggregation pipeline update, which skips every validator the
 * per-item save paths use -- including the one that refuses a price above the
 * printed MRP. Without the clamp a broad increase here would quietly put items
 * on sale above their MRP, which is illegal, and no screen would say so.
 *
 * Clamped rather than refused: blocking the whole run because one dish would
 * cross its MRP would make the feature unusable on a large menu. The count of
 * clamped items is reported back so the admin is told rather than guessing.
 *
 * An MRP of null or 0 means "not recorded", so those items scale freely.
 */
const scalePriceExpr = (field, factor) => {
    const scaled = { $max: [MIN_RESULT_PRICE, { $round: [{ $multiply: [`$${field}`, factor] }, 2] }] };
    return {
        $cond: [
            { $gt: [{ $ifNull: ['$mrp', 0] }, 0] },
            { $min: [scaled, '$mrp'] },
            scaled
        ]
    };
};

/**
 * Scale a menu, keeping base price and discount coherent.
 *
 * `price` is derived (basePrice less discountPercent), so scaling price alone
 * would leave the two disagreeing -- the item would advertise "20% off 50" while
 * charging something that is not 40. The base is scaled and the selling price
 * re-derived from it, in two stages: a later stage in an aggregation-pipeline
 * update sees what an earlier one wrote.
 *
 * Clamping stays on the base rather than the selling price. Since the selling
 * price is at most the base, holding the base at the MRP keeps the whole item
 * under it, and does so without breaking the invariant the way clamping only
 * the derived price would.
 *
 * Rows predating basePrice have null there; $multiply on null yields null, which
 * readers already treat as "base equals price", so they scale on price alone and
 * stay correct.
 */
const applyFactorToMenu = async (filter, factor) => {
    const clampToMrp = (scaledExpr) => ({
        $cond: [
            { $gt: [{ $ifNull: ['$mrp', 0] }, 0] },
            { $min: [scaledExpr, '$mrp'] },
            scaledExpr
        ]
    });
    const scaled = (expr) => ({ $max: [MIN_RESULT_PRICE, { $round: [{ $multiply: [expr, factor] }, 2] }] });

    const result = await FoodItem.updateMany(filter, [
        {
            $set: {
                basePrice: {
                    $cond: [
                        { $gt: [{ $ifNull: ['$basePrice', 0] }, 0] },
                        clampToMrp(scaled('$basePrice')),
                        null
                    ]
                },
                price: clampToMrp(scaled('$price')),
                variants: {
                    $map: {
                        input: { $ifNull: ['$variants', []] },
                        as: 'variant',
                        in: {
                            $mergeObjects: [
                                '$$variant',
                                {
                                    // Variants have no MRP of their own; the item's
                                    // MRP caps every size, same as the per-item save
                                    // path, which validates the highest variant.
                                    price: clampToMrp(scaled('$$variant.price'))
                                }
                            ]
                        }
                    }
                }
            }
        },
        {
            // Re-derive the selling price from the scaled base, so the discount the
            // restaurant set still holds. Only for rows that actually carry a base;
            // the stage above already scaled price directly for the rest.
            $set: {
                price: {
                    $cond: [
                        { $gt: [{ $ifNull: ['$basePrice', 0] }, 0] },
                        {
                            $max: [
                                MIN_RESULT_PRICE,
                                {
                                    $round: [
                                        {
                                            $multiply: [
                                                '$basePrice',
                                                { $subtract: [1, { $divide: [{ $ifNull: ['$discountPercent', 0] }, 100] }] }
                                            ]
                                        },
                                        2
                                    ]
                                }
                            ]
                        },
                        '$price'
                    ]
                }
            }
        }
    ]);
    return result?.modifiedCount || 0;
};

/**
 * How many items this factor would push above their MRP, and so be held there.
 *
 * Counted before the write for the preview, and again after for the message the
 * admin sees, because "42 items updated" reads very differently from "42 items
 * updated, 6 held at their MRP".
 */
const countItemsCappedByMrp = async (filter, factor) => FoodItem.countDocuments({
    ...filter,
    mrp: { $gt: 0 },
    $expr: { $gt: [{ $multiply: ['$price', factor] }, '$mrp'] },
});

export async function listPriceAdjustments({ limit = 20 } = {}) {
    const capped = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const adjustments = await FoodPriceAdjustment.find({})
        .sort({ createdAt: -1 })
        .limit(capped)
        .lean();
    return { adjustments };
}

export async function getPriceAdjustmentPreview({ restaurantId, percent } = {}) {
    const { restaurantName } = await resolveRestaurant(restaurantId);
    const filter = buildFilter(restaurantId);
    const itemCount = await FoodItem.countDocuments(filter);

    // Only meaningful once a percent has been typed, and only an increase can
    // push anything into its MRP.
    const pct = Number(percent);
    const itemsCappedByMrp = Number.isFinite(pct) && pct > 0
        ? await countItemsCappedByMrp(filter, 1 + pct / 100)
        : 0;

    return { itemCount, restaurantName, itemsCappedByMrp };
}

/**
 * Scale the struck-through comparison figure -- basePrice in the current
 * pricing system, not the retired otherPrice field. resolveItemDisplayPricing
 * (shared/itemDiscountPricing.js) only ever reads price/basePrice/discountPercent,
 * so scaling otherPrice alone -- the old behaviour here -- never reached the
 * customer no matter what it was set to.
 *
 * Selling price (`price`) stays untouched, matching "only the struck-through
 * figure". An item with no base recorded yet is seeded from its current price:
 * that IS the comparison this run is creating, not an invented one --
 * resolveItemDisplayPricing already treats a null base as "no discount" until
 * something sets it, which is exactly the state every skipped item was stuck in.
 *
 * discountPercent is rewritten alongside basePrice in a second stage: the
 * display function trusts a stored discountPercent as-is and only shows a
 * discount when it is above 0, so raising basePrice without it would still
 * silently not display.
 *
 * otherPrice is kept in step too, for anything else that might still read it --
 * harmless, and cheaper than proving nothing does.
 */
const applyFactorToComparison = async (filter, factor) => {
    const clampToMrp = (scaledExpr) => ({
        $cond: [
            { $gt: [{ $ifNull: ['$mrp', 0] }, 0] },
            { $min: [scaledExpr, '$mrp'] },
            scaledExpr,
        ],
    });
    const scaled = (expr) => ({
        $max: [MIN_RESULT_PRICE, { $round: [{ $multiply: [expr, factor] }, 2] }],
    });

    const result = await FoodItem.updateMany(filter, [
        {
            $set: {
                basePrice: clampToMrp(
                    scaled({
                        $cond: [
                            { $gt: [{ $ifNull: ['$basePrice', 0] }, 0] },
                            '$basePrice',
                            '$price',
                        ],
                    }),
                ),
                otherPrice: {
                    $cond: [
                        { $gt: [{ $ifNull: ['$otherPrice', 0] }, 0] },
                        scaled('$otherPrice'),
                        '$otherPrice',
                    ],
                },
            },
        },
        {
            $set: {
                discountPercent: {
                    $cond: [
                        { $gt: ['$basePrice', '$price'] },
                        {
                            $round: [
                                {
                                    $multiply: [
                                        { $divide: [{ $subtract: ['$basePrice', '$price'] }, '$basePrice'] },
                                        100,
                                    ],
                                },
                                2,
                            ],
                        },
                        0,
                    ],
                },
            },
        },
    ]);
    return result?.modifiedCount || 0;
};

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
    const filter = buildFilter(restaurantId);

    // Which number this run moves. Defaults to the comparison figure, so a
    // mis-click cannot silently reprice a live menu -- changing what customers
    // are charged has to be asked for.
    const target = String(body.target || 'otherPrice') === 'price' ? 'price' : 'otherPrice';

    // Counted before the write, because afterwards the prices have already been
    // held at MRP and the comparison no longer finds them. Only meaningful when
    // selling prices are the thing being moved.
    const itemsCappedByMrp = target === 'price' ? await countItemsCappedByMrp(filter, factor) : 0;
    const itemsUpdated = target === 'price'
        ? await applyFactorToMenu(filter, factor)
        : await applyFactorToComparison(filter, factor);

    const adjustment = await FoodPriceAdjustment.create({
        percent,
        factor,
        target,
        restaurantId,
        restaurantName,
        itemsUpdated,
        itemsCappedByMrp,
        ...(await resolveActor(actor))
    });

    return { adjustment: adjustment.toObject(), itemsUpdated, itemsCappedByMrp };
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

    // Undo the number the original run moved. This always scaled the selling
    // price regardless of what the run targeted, so reverting a comparison
    // adjustment repriced the live menu -- the one thing that run had
    // deliberately left alone.
    const target = String(original.target || 'otherPrice') === 'price' ? 'price' : 'otherPrice';
    const filter = buildFilter(original.restaurantId);
    const itemsUpdated = target === 'price'
        ? await applyFactorToMenu(filter, inverse)
        : await applyFactorToComparison(filter, inverse);

    original.isReverted = true;
    await original.save();

    const revertEntry = await FoodPriceAdjustment.create({
        percent: (inverse - 1) * 100,
        factor: inverse,
        target,
        restaurantId: original.restaurantId,
        restaurantName: original.restaurantName,
        itemsUpdated,
        revertsAdjustmentId: original._id,
        ...(await resolveActor(actor))
    });

    return { adjustment: revertEntry.toObject(), itemsUpdated };
}
