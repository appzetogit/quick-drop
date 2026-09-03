import mongoose from 'mongoose';
import { NINETY_NINE_STORE_MAX_PRICE } from '../../shared/ninetyNineStore.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { getFoodDisplayPrice, serializeFoodVariants } from '../../admin/services/foodVariant.service.js';
import { describeTodaysWindow, isFoodAvailableNow } from '../../shared/itemAvailability.js';
import { resolveItemDisplayPricing } from '../../shared/itemDiscountPricing.js';

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildCategoryKeywords = (categorySlug) => {
    const raw = String(categorySlug || '').trim().toLowerCase();
    if (!raw || raw === 'all') return [];

    const normalized = raw.replace(/&/g, ' and ').replace(/-/g, ' ').trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    return [...new Set([raw, normalized, ...words])];
};

/**
 * The Rs 99 store: an admin-curated shelf, capped by price.
 *
 * This used to be `String(price).includes('99')`, which is a string match and
 * not a price rule -- it admitted 199, 299, 1099 and 1.99 while excluding 95.
 * Eligibility is now the admin's toggle on the dish, and the ceiling is applied
 * here at read time so a dish that later rises above the cap leaves the shelf
 * by itself rather than needing the flag cleared by hand.
 */
const UNDER_250_MAX_PRICE = 250;

const qualifiesFor99Store = (food, price) =>
    food?.showIn99Store === true
    && Number.isFinite(Number(price))
    && Number(price) <= NINETY_NINE_STORE_MAX_PRICE;

export async function listPublicFoods(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 1000);
    const zoneIdRaw = String(query.zoneId || '').trim();
    const categorySlug = String(query.categorySlug || query.category || '').trim().toLowerCase();
    const promo = String(query.promo || query.promoSlug || '').trim().toLowerCase();
    // Two different shelves that shared one flag. The 99 store is curated by the
    // admin and capped at Rs 99; under-250 is purely a price band, as its name
    // says -- it was matching the same "contains 99" string as everything else.
    const is99StorePromo = promo === 'switch99' || promo === '99-store' || promo === 'store99';
    const isUnder250Promo = promo === 'under-250' || promo === 'under250';
    const isPromoList = is99StorePromo || isUnder250Promo;

    const restaurantFilter = { status: 'approved' };
    if (zoneIdRaw && mongoose.Types.ObjectId.isValid(zoneIdRaw)) {
        restaurantFilter.zoneId = new mongoose.Types.ObjectId(zoneIdRaw);
    }

    // The other-platform comparison markup, read once for the whole list. It is
    // applied to each item's selling price at render time rather than stored, so
    // a global price adjustment moves it automatically.
    const { FoodFeeSettings } = await import('../../admin/models/feeSettings.model.js');
    const { normalizeOtherPlatformSettings, resolveComparisonPrice, resolveItemOtherPlatformPrice } =
        await import('../../shared/otherPlatformPricing.js');
    const feeDoc = await FoodFeeSettings.findOne({ isActive: true }).sort({ createdAt: -1 }).lean();
    const otherPlatform = normalizeOtherPlatformSettings(feeDoc || {});

    const restaurants = await FoodRestaurant.find(restaurantFilter)
        .select('_id restaurantName slug zoneId profileImage rating totalRatings ratingCount estimatedDeliveryTime estimatedDeliveryTimeMinutes location coverImages menuImages isActive isAcceptingOrders outletTimings openDays deliveryTimings openingTime closingTime')
        .lean();

    if (!restaurants.length) {
        return { foods: [], total: 0 };
    }

    const restaurantMap = new Map(
        restaurants.map((restaurant) => [String(restaurant._id), restaurant])
    );
    const restaurantIds = restaurants.map((restaurant) => restaurant._id);

    const foodFilter = {
        restaurantId: { $in: restaurantIds },
        approvalStatus: 'approved',
        isAvailable: { $ne: false }
    };

    const keywords = buildCategoryKeywords(categorySlug);
    if (keywords.length > 0) {
        foodFilter.$or = keywords.flatMap((keyword) => {
            const rx = escapeRegex(keyword);
            return [
                { name: { $regex: rx, $options: 'i' } },
                { categoryName: { $regex: rx, $options: 'i' } }
            ];
        });
    }

    const list = await FoodItem.find(foodFilter)
        .sort({ createdAt: -1 })
        .limit(isPromoList ? Math.max(limit, 2000) : limit)
        .lean();

    // Which dishes are on a buy-one-get-one right now. One query for the whole
    // page rather than one per kitchen on it, and read at render time so a run
    // window opening or closing takes effect without anyone re-saving the dish.
    const { getLiveBogoOffersByItem, describeBogoBadge } =
        await import('../../shared/bogoOffer.service.js');
    const bogoOffersByItem = await getLiveBogoOffersByItem(restaurantIds);

    // One clock for the whole page, so two items cannot straddle a minute boundary.
    const now = new Date();
    const foods = list
        .map((food) => {
        const restaurant = restaurantMap.get(String(food.restaurantId));
        const price = getFoodDisplayPrice(food);
        return {
            id: food._id,
            _id: food._id,
            // Serving window, resolved server-side so the app never has to reason
            // about the restaurant's timezone. The order API enforces it again.
            availabilitySchedule: food.availabilitySchedule || null,
            isAvailableNow: isFoodAvailableNow(food, now),
            availabilityWindowLabel: describeTodaysWindow(food.availabilitySchedule, now),
            restaurantId: food.restaurantId,
            restaurantName: restaurant?.restaurantName || 'Unknown Restaurant',
            categoryId: food.categoryId || null,
            categoryName: food.categoryName || '',
            category: food.categoryName || '',
            name: food.name,
            description: food.description || '',
            price,
            // Base price and the discount off it, so the app can strike through
            // a price and show "N% OFF" without deriving the rule itself.
            // strikePrice is null whenever there is nothing honest to show, so the
            // client can render it unconditionally instead of guessing.
            ...(() => {
                // Effective price in, as the menu endpoint does: for a dish sold by
                // variants the raw price is the base, not what it starts from, and
                // spreading display.price over the effective one put variant
                // dishes over the Rs 99 cap that their cheapest size was under.
                const display = resolveItemDisplayPricing({ ...food, price });
                // Per-item figure wins over the blanket markup; see
                // shared/otherPlatformPricing.js for why.
                const otherPlatformPrice = resolveItemOtherPlatformPrice(
                    { ...food, price: display.price },
                    otherPlatform,
                );
                // One struck-through figure, not two: whichever is higher between
                // the restaurant's own pre-discount price and the platform
                // comparison. Labelled, because a struck "Rs.100" means different
                // things depending on which it is.
                const comparison = resolveComparisonPrice({
                    price: display.price,
                    basePrice: display.basePrice,
                    otherPlatformPrice,
                    label: otherPlatform.label,
                });
                return { ...display, otherPrice: Number(food.otherPrice) || 0, otherPlatformPrice, ...comparison };
            })(),
            // The add-ons this dish offers. The order API re-checks the list, so
            // this is for showing the right picker, not for deciding what is allowed.
            addonIds: (food.addonIds || []).map((x) => String(x)),
            // Both keys, exactly as the restaurant-menu payload sends them.
            //
            // These were missing entirely, so a dish with sizes arrived here
            // looking like a plain one. The app added it to the cart with no
            // variant and had nothing to render a size picker from, while
            // checkout — which reads the dish from the database — correctly
            // refused with "please select a size". The customer was left with an
            // error and no control that could clear it.
            // Variant rows are withheld while the toggle is off. They stay in the
            // database on purpose -- switching variants off is meant to be
            // reversible -- but serving them let clients price from a row the
            // dish is not sold by. Missi Roti sells for 50 with variants off and
            // still carried a 26.52 'half' row, so the app advertised 26.52 for a
            // dish that charges 50.
            variants: (food.variantsEnabled !== false) ? serializeFoodVariants(food.variants) : [],
            // The toggle, tri-state on old rows: absent means "sell by variants if"
            // "any exist", which is what those rows always did. Serialised as the
            // resolved boolean so no client re-derives the legacy rule.
            variantsEnabled: food.variantsEnabled !== false,
            variations: (food.variantsEnabled !== false) ? serializeFoodVariants(food.variants) : [],
            image: food.image || '',
            // Falls back to the single image so a dish saved before galleries
            // existed still returns a one-entry list — the app can then always
            // read `images` without special-casing the old shape.
            images: Array.isArray(food.images) && food.images.length
                ? food.images
                : (food.image ? [food.image] : []),
            foodType: food.foodType || 'Non-Veg',
            isAvailable: food.isAvailable !== false,
            // Carried through so the shelf filter below can read it, and so the
            // app can badge a dish as part of the Rs 99 store.
            showIn99Store: food.showIn99Store === true,
            // A combo is an ordinary dish to order, but the app has to be able to
            // say what is inside one. Without these two the customer sees a
            // cheaper dish and no reason why.
            isCombo: food.isCombo === true,
            comboComponents: food.isCombo === true
                ? (food.comboComponents || []).map((c) => ({
                    itemId: String(c.itemId || ''),
                    variantId: c.variantId ? String(c.variantId) : '',
                    quantity: Number(c.quantity) || 1,
                    name: c.nameSnapshot || '',
                    variantName: c.variantNameSnapshot || '',
                    listUnitPrice: Number(c.listUnitPrice) || 0,
                }))
                : [],
            // The buy-one-get-one badge, or null. Phrased by the server so every
            // surface words the same ratio identically.
            bogo: describeBogoBadge(bogoOffersByItem, food._id),
            freeDelivery: food.freeDelivery === true,
            preparationTime: food.preparationTime || '',
            approvalStatus: food.approvalStatus || 'approved'
        };
    })
        .filter((food) => {
            if (food.isAvailable === false) return false;
            if (is99StorePromo) return qualifiesFor99Store(food, food.price);
            if (isUnder250Promo) {
                const value = Number(food.price);
                return Number.isFinite(value) && value <= UNDER_250_MAX_PRICE;
            }
            return true;
        })
        .slice(0, limit);

    return { foods, total: foods.length };
}
