import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodCategory } from '../../admin/models/category.model.js';
import { getFoodDisplayPrice, serializeFoodVariants } from '../../admin/services/foodVariant.service.js';
import { formatOrderQuantityLimits } from '../../shared/orderQuantityRules.js';
import { resolveItemPackagingAmount } from '../../shared/packagingCharge.js';
import { describeTodaysWindow, isFoodAvailableNow } from '../../shared/itemAvailability.js';
import { getOrderQuantityCeiling } from '../../shared/orderQuantityCeiling.js';
import { resolveItemDisplayPricing } from '../../shared/itemDiscountPricing.js';
import { normalizeOtherPlatformSettings, resolveComparisonPrice, resolveItemOtherPlatformPrice } from '../../shared/otherPlatformPricing.js';

const buildMenuFromFoods = async (foods = []) => {
    // Admin-configurable platform cap, so the limits the seller UI shows match
    // what checkout will actually enforce. Read once per menu, not per item.
    const quantityCeiling = await getOrderQuantityCeiling();

    // Which dishes are on a buy-one-get-one right now, in one query for the whole
    // menu. Read here rather than stored on the dish so a run window opening or
    // closing takes effect without anyone re-saving the item.
    const { getLiveBogoOffersByItem, describeBogoBadge } =
        await import('../../shared/bogoOffer.service.js');
    const bogoOffersByItem = await getLiveBogoOffersByItem(
        (foods || []).map((food) => food?.restaurantId).filter(Boolean),
    );

    // The other-platform comparison markup, also read once. Applied to each
    // item's selling price at render time rather than stored, so a global price
    // adjustment carries it along automatically.
    const { FoodFeeSettings } = await import('../../admin/models/feeSettings.model.js');
    const feeDoc = await FoodFeeSettings.findOne({ isActive: true }).sort({ createdAt: -1 }).lean();
    const otherPlatform = normalizeOtherPlatformSettings(feeDoc || {});

    const categoryIds = Array.from(
        new Set(
            (foods || [])
                .map((food) => {
                    const raw = food?.categoryId;
                    if (!raw) return '';
                    return String(raw);
                })
                .filter((value) => mongoose.Types.ObjectId.isValid(value))
        )
    );

    const categoryDocs = categoryIds.length
        ? await FoodCategory.find({ _id: { $in: categoryIds } })
            .select('name image sortOrder')
            .lean()
        : [];
    const categoryMap = new Map(categoryDocs.map((doc) => [String(doc._id), doc]));

    const byCategory = new Map();
    for (const food of foods) {
        const isFoodAvailable = food?.isActive !== false && food?.isAvailable !== false;
        const categoryId = food?.categoryId ? String(food.categoryId) : '';
        const categoryDoc = categoryMap.get(categoryId) || null;
        const sectionName = (categoryDoc?.name || food?.categoryName || food?.category || 'Menu').trim() || 'Menu';
        const groupKey = categoryId || `name:${sectionName.toLowerCase()}`;

        if (!byCategory.has(groupKey)) {
            byCategory.set(groupKey, {
                id: categoryId || null,
                name: sectionName,
                image: categoryDoc?.image || '',
                sortOrder: Number.isFinite(Number(categoryDoc?.sortOrder)) ? Number(categoryDoc.sortOrder) : Number.MAX_SAFE_INTEGER,
                items: []
            });
        }

        byCategory.get(groupKey).items.push({
            id: String(food._id),
            _id: food._id,
            categoryId: categoryId || null,
            categoryName: sectionName,
            category: sectionName,
            name: food.name,
            description: food.description || '',
            price: getFoodDisplayPrice(food),
            // MRP + the discount it implies, so the seller sees what the customer sees.
            // Base price, discount and the strike price to render. The item form
            // sends these, so they have to come back or the fields hydrate blank and
            // the next save writes the blanks over what the restaurant set.
            ...(() => {
                const display = resolveItemDisplayPricing({ ...food, price: getFoodDisplayPrice(food) });
                // Per-item figure wins over the blanket markup; see
                // shared/otherPlatformPricing.js for why.
                const otherPlatformPrice = resolveItemOtherPlatformPrice(
                    { ...food, price: display.price },
                    otherPlatform,
                );
                const comparison = resolveComparisonPrice({
                    price: display.price,
                    basePrice: display.basePrice,
                    otherPlatformPrice,
                    label: otherPlatform.label,
                });
                return { ...display, otherPrice: Number(food.otherPrice) || 0, otherPlatformPrice, ...comparison };
            })(),
            // Which add-ons this dish offers, so the editor can show the picker
            // pre-filled and the app can offer only the relevant ones.
            addonIds: (food.addonIds || []).map((x) => String(x)),
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
            // The buy-one-get-one badge, or null. Phrased by the server so the
            // menu, the dish card and the cart cannot word the same ratio three
            // different ways.
            bogo: describeBogoBadge(bogoOffersByItem, food._id),
            freeDelivery: food.freeDelivery === true,
            variations: (food.variantsEnabled !== false) ? serializeFoodVariants(food.variants) : [],
            image: food.image || '',
            foodType: food.foodType || 'Non-Veg',
            isActive: food.isActive !== false,
            isAvailable: isFoodAvailable,
            isRecommended: food.isRecommended === true,
            approvalStatus: food.approvalStatus || 'approved',
            rejectionReason: food.rejectionReason || '',
            requestedAt: food.requestedAt,
            approvedAt: food.approvedAt,
            rejectedAt: food.rejectedAt,
            preparationTime: food.preparationTime || '',
            ...formatOrderQuantityLimits(food, quantityCeiling),
            packagingCharge: {
                isEnabled: food?.packagingCharge?.isEnabled === true,
                amount: resolveItemPackagingAmount(food)
            },
            /*
             * Whether this dish's price already contains GST. Null, not false,
             * when the dish never answered -- it then follows the restaurant's
             * own setting, and the form has to be able to show "inherited"
             * rather than claiming the restaurant chose exclusive.
             */
            priceIncludesGst: typeof food.priceIncludesGst === 'boolean'
                ? food.priceIncludesGst
                : null,
            // Serving window, so the menu editor can show what is stored and the
            // dashboard can mark an item as outside its hours right now.
            availabilitySchedule: food.availabilitySchedule || null,
            isAvailableNow: isFoodAvailableNow(food),
            // The hours themselves, so a dish shown as unavailable can say when it
            // will be. Without this the customer is told no, but not when to come
            // back. Empty for items with no schedule, which is most of them.
            availabilityWindowLabel: describeTodaysWindow(food.availabilitySchedule),
            createdAt: food.createdAt,
            updatedAt: food.updatedAt
        });
    }

    const orderedGroups = Array.from(byCategory.values()).sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const sections = orderedGroups.map((group, idx) => ({
        id: group.id || `section-${idx}`,
        categoryId: group.id || null,
        name: group.name,
        image: group.image || '',
        sortOrder: Number.isFinite(Number(group.sortOrder)) ? Number(group.sortOrder) : 0,
        itemCount: group.items.length,
        items: group.items.sort((a, b) => {
            const at = new Date(a.createdAt || a.requestedAt || 0).getTime();
            const bt = new Date(b.createdAt || b.requestedAt || 0).getTime();
            return bt - at;
        }),
        subsections: []
    }));

    const categories = sections.map((section) => ({
        id: section.categoryId || section.id,
        categoryId: section.categoryId || null,
        name: section.name,
        image: section.image || '',
        sortOrder: section.sortOrder || 0,
        itemCount: section.itemCount || 0
    }));

    return { sections, categories };
};

export async function getRestaurantMenu(restaurantId) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Invalid restaurant id');
    }
    const foods = await FoodItem.find({ restaurantId })
        .sort({ createdAt: -1 })
        .limit(5000)
        .lean();
    return buildMenuFromFoods(foods);
}

export async function updateRestaurantMenu(restaurantId, body = {}) {
    // Option A: single source of truth (food_items). Menu layout snapshots are disabled.
    // Keep endpoint for backward compatibility, but make it explicit.
    throw new ValidationError('Menu editing is disabled. Menu is generated from food items.');
}

export async function getPublicApprovedRestaurantMenu(restaurantIdOrSlug) {
    const value = String(restaurantIdOrSlug || '').trim();
    if (!value) throw new ValidationError('Restaurant id is required');

    let restaurant = null;
    if (/^[0-9a-fA-F]{24}$/.test(value)) {
        restaurant = await FoodRestaurant.findOne({ _id: value, status: 'approved' })
            .select('_id status')
            .lean();
    } else {
        const normalized = value.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
        restaurant = await FoodRestaurant.findOne({ restaurantNameNormalized: normalized, status: 'approved' })
            .select('_id status')
            .lean();
    }

    if (!restaurant?._id) {
        return null;
    }
    const foods = await FoodItem.find({
        restaurantId: restaurant._id,
        approvalStatus: 'approved',
        isActive: { $ne: false },
        isAvailable: { $ne: false }
    })
        .sort({ createdAt: -1 })
        .limit(2000)
        .lean();
    return buildMenuFromFoods(foods);
}

export async function syncMenuItemApprovalStatus(restaurantId, itemId, status, rejectionReason = '') {
    // No-op in Option A (menu snapshots removed). Approval status lives only in food_items.
    // Kept to avoid breaking admin approval flows that call this helper.
    return;
}
