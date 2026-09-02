import mongoose from 'mongoose';
import { FoodItem } from '../models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodPriceAdjustment } from '../models/priceAdjustment.model.js';
import { FoodFeeSettings } from '../models/feeSettings.model.js';
import {
    normalizeOtherPlatformSettings,
    MAX_MARKUP_PERCENT,
} from '../../shared/otherPlatformPricing.js';
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
 * Scale the struck-through comparison figure. What the customer is charged is
 * untouched -- this moves the "elsewhere" price beside it.
 *
 * Most dishes have no per-item figure: the comparison is derived from the
 * selling price via one admin markup, which is what makes it track price
 * changes. Scaling only stored figures therefore moved a handful of rows and
 * looked broken -- on this platform 8 items of 70 had one, so a run reported
 * success and nothing visibly changed.
 *
 * So the number moved depends on what the run covers:
 *
 *  - Platform-wide: move the markup itself, which reprices every dish at once,
 *    including the ones whose stored figure is 0 or absent. Composed rather
 *    than added -- +10% on a 20% markup is 1.20 x 1.10, i.e. 32%, not 30%.
 *  - One restaurant: a global markup cannot be moved for a single restaurant,
 *    so its dishes get a stored figure seeded from what they currently show,
 *    then scaled. Those dishes stop tracking the markup, which is the price of
 *    scoping the run this way.
 *
 * Stored figures are always scaled, so a dish the restaurant priced by hand
 * keeps pace either way.
 */
const applyFactorToComparison = async (filter, factor, restaurantId = null) => {
    const scaleExpr = (field) => ({
        $max: [MIN_RESULT_PRICE, { $round: [{ $multiply: [`$${field}`, factor] }, 2] }],
    });

    const scaled = await FoodItem.updateMany(
        { ...filter, otherPrice: { $gt: 0 } },
        [{ $set: { otherPrice: scaleExpr('otherPrice') } }],
    );
    const itemsScaled = scaled?.modifiedCount || 0;

    const feeDoc = await FoodFeeSettings.findOne({ isActive: true }).lean();
    const settings = normalizeOtherPlatformSettings(feeDoc || {});

    if (!restaurantId) {
        // Composing the factor onto the markup keeps repeated runs consistent
        // with what scaling a stored figure would have done.
        const nextMarkup = Math.min(
            Math.max(((1 + settings.markupPercent / 100) * factor - 1) * 100, 0),
            MAX_MARKUP_PERCENT,
        );
        const markupPercent = Math.round(nextMarkup * 100) / 100;
        await FoodFeeSettings.updateMany({}, { $set: { 'otherPlatformPrice.markupPercent': markupPercent } });

        const itemsOnMarkup = await FoodItem.countDocuments({
            ...filter,
            $or: [{ otherPrice: null }, { otherPrice: { $lte: 0 } }, { otherPrice: { $exists: false } }],
        });

        return {
            itemsUpdated: itemsScaled + itemsOnMarkup,
            itemsScaled,
            itemsOnMarkup,
            markupPercentBefore: settings.markupPercent,
            markupPercentAfter: markupPercent,
        };
    }

    // Scoped run: seed from the figure the dish shows today, then scale it.
    const markupFactor = 1 + settings.markupPercent / 100;
    const seeded = await FoodItem.updateMany(
        {
            ...filter,
            price: { $gt: 0 },
            $or: [{ otherPrice: null }, { otherPrice: { $lte: 0 } }, { otherPrice: { $exists: false } }],
        },
        [{
            $set: {
                otherPrice: {
                    $max: [
                        MIN_RESULT_PRICE,
                        { $round: [{ $multiply: ['$price', markupFactor * factor] }, 2] },
                    ],
                },
            },
        }],
    );

    return {
        itemsUpdated: itemsScaled + (seeded?.modifiedCount || 0),
        itemsScaled,
        itemsSeeded: seeded?.modifiedCount || 0,
        markupPercentBefore: settings.markupPercent,
        markupPercentAfter: settings.markupPercent,
    };
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

    let itemsUpdated = 0;
    let comparison = null;
    if (target === 'price') {
        itemsUpdated = await applyFactorToMenu(filter, factor);
    } else {
        comparison = await applyFactorToComparison(filter, factor, restaurantId);
        itemsUpdated = comparison.itemsUpdated;
    }

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

    // The markup figures are returned so the admin sees what actually moved --
    // a run that repriced every dish via the markup used to report only the
    // handful of stored figures it touched, which read as "nothing happened".
    return { adjustment: adjustment.toObject(), itemsUpdated, itemsCappedByMrp, ...(comparison || {}) };
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

    // Undo the number the original run moved. This used to always scale the
    // selling price, so reverting a comparison-price run silently repriced the
    // live menu -- the one thing that run had deliberately left alone.
    const target = String(original.target || 'otherPrice') === 'price' ? 'price' : 'otherPrice';
    const filter = buildFilter(original.restaurantId);
    const itemsUpdated = target === 'price'
        ? await applyFactorToMenu(filter, inverse)
        : (await applyFactorToComparison(filter, inverse, original.restaurantId)).itemsUpdated;

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
