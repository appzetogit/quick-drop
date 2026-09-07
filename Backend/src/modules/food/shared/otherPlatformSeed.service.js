import { FoodItem } from '../admin/models/food.model.js';
import { collectOtherPriceRatios } from './otherPlatformPricing.js';

/**
 * The comparison figure a dish should be created with, read from its siblings.
 *
 * A global price adjustment moves the stored otherPrice on the dishes that
 * exist when it runs. Anything added later carries nothing and falls back to
 * the blanket markup, so it advertises a smaller saving than every dish beside
 * it -- 20% next to neighbours at 30% or 70%. This closes that gap at the one
 * moment it can be closed cheaply: creation.
 *
 * The restaurant's own dishes are consulted FIRST. Comparison figures are set
 * per restaurant by adjustments that are often scoped to one restaurant, so a
 * platform-wide median would import another menu's history over a menu that
 * has one of its own.
 *
 * A restaurant that has just onboarded has no history to protect, and that was
 * the hole: its very first dishes found no siblings, seeded nothing, and fell
 * back to the blanket markup -- so a brand-new restaurant advertised a smaller
 * saving than every established one, and no past platform-wide adjustment
 * reached it at all. For that case only, the median widens to the platform.
 *
 * Never throws: failing to seed a comparison figure must not fail a dish save.
 * The blanket markup then applies, which is exactly today's behaviour.
 */
export async function resolveSeedOtherPriceForRestaurant(restaurantId, price) {
    const selling = Number(price);
    if (!Number.isFinite(selling) || selling <= 0) return 0;

    const ratio = await resolveSeedRatioForRestaurant(restaurantId);
    if (!(ratio > 1)) return 0;

    const seeded = Math.round(selling * ratio * 100) / 100;
    return seeded > selling ? seeded : 0;
}

/**
 * The same answer as a ratio rather than a price, for callers writing many
 * dishes at once.
 *
 * A bulk menu upload creates a whole restaurant's dishes in one bulkWrite, and
 * looking the median up per dish would be one query per row. Resolved once, the
 * ratio multiplies each row's own price inside the write.
 *
 * Returns 0 when there is nothing to go on, which callers must read as "leave
 * otherPrice alone" -- the blanket markup then applies, as it always did.
 */
export async function resolveSeedRatioForRestaurant(restaurantId) {
    try {
        if (restaurantId) {
            // A sample, not the whole menu: the median of the most recent fifty
            // is the same answer as the median of five hundred, for a fraction
            // of the read. Newest first, so a menu that has drifted reflects
            // where it is now rather than where it started.
            const siblings = await FoodItem.find({
                restaurantId,
                otherPrice: { $gt: 0 },
            })
                .select('price otherPrice')
                .sort({ createdAt: -1 })
                .limit(50)
                .lean();

            const own = medianRatio(collectOtherPriceRatios(siblings));
            if (own > 1) return own;
        }

        /*
         * Nothing on this menu carries a figure yet -- a restaurant on its first
         * dishes. Widen to the platform so it starts where everyone else already
         * is, rather than on the blanket markup, which is the one number no
         * adjustment has ever touched.
         *
         * A wider sample than the per-restaurant one: this median stands in for
         * every menu rather than a single kitchen, and it is read once per menu
         * upload rather than per dish.
         */
        const platformWide = await FoodItem.find({ otherPrice: { $gt: 0 } })
            .select('price otherPrice')
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();

        return medianRatio(collectOtherPriceRatios(platformWide));
    } catch (err) {
        console.error('Other-platform seed lookup failed:', err?.message || err);
        return 0;
    }
}

/**
 * Median of the usable ratios, or 0.
 *
 * resolveSeedOtherPrice already computes this, but only ever hands back a
 * price. Sharing the median itself is what lets one lookup serve a whole
 * upload, and keeps both callers on the same statistic.
 */
function medianRatio(ratios) {
    const usable = (Array.isArray(ratios) ? ratios : [])
        .map((r) => Number(r))
        .filter((r) => Number.isFinite(r) && r > 1)
        .sort((a, b) => a - b);
    if (!usable.length) return 0;
    const mid = Math.floor(usable.length / 2);
    return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}
