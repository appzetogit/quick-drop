import { FoodItem } from '../admin/models/food.model.js';
import { collectOtherPriceRatios, resolveSeedOtherPrice } from './otherPlatformPricing.js';

/**
 * The comparison figure a dish should be created with, read from its siblings.
 *
 * A global price adjustment moves the stored otherPrice on the dishes that
 * exist when it runs. Anything added later carries nothing and falls back to
 * the blanket markup, so it advertises a smaller saving than every dish beside
 * it -- 20% next to neighbours at 30% or 70%. This closes that gap at the one
 * moment it can be closed cheaply: creation.
 *
 * Only the restaurant's own dishes are consulted. Comparison figures are set
 * per restaurant by adjustments that are often scoped to one restaurant, so a
 * platform-wide median would import another menu's history.
 *
 * Never throws: failing to seed a comparison figure must not fail a dish save.
 * The blanket markup then applies, which is exactly today's behaviour.
 */
export async function resolveSeedOtherPriceForRestaurant(restaurantId, price) {
    if (!restaurantId) return 0;
    const selling = Number(price);
    if (!Number.isFinite(selling) || selling <= 0) return 0;

    try {
        // A sample, not the whole menu: the median of the most recent fifty is
        // the same answer as the median of five hundred, for a fraction of the
        // read. Newest first, so a menu that has drifted reflects where it is
        // now rather than where it started.
        const siblings = await FoodItem.find({
            restaurantId,
            otherPrice: { $gt: 0 },
        })
            .select('price otherPrice')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        return resolveSeedOtherPrice({
            price: selling,
            siblingRatios: collectOtherPriceRatios(siblings),
        });
    } catch (err) {
        console.error('Other-platform seed lookup failed:', err?.message || err);
        return 0;
    }
}
