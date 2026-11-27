import { ValidationError } from '../../../../../core/auth/errors.js';

/**
 * How a quick-commerce store is run: an outside shop on the marketplace, or a
 * Quickdrops dark store. Separate from storeType, which is what the store sells.
 *
 * The one rule that differs for customers: a dark-store product reaches them
 * only after a purchase has put it in stock. `firstStockedAt` on the product is
 * set by the first purchase bill or fresh-sheet stock entry and never cleared,
 * so a product that later sells out stays listed as out of stock instead of
 * disappearing. A marketplace product goes live once approved, as before.
 *
 * Every customer-facing product read (store menu, search, favourites, share
 * links, checkout) applies this through the helpers below.
 */

export const OPERATING_MODELS = Object.freeze(['marketplace', 'dark_store']);
export const DEFAULT_OPERATING_MODEL = 'marketplace';
export const DARK_STORE = 'dark_store';
export const DARK_STORE_OWNERS = Object.freeze(['platform', 'partner']);

export const OPERATING_MODEL_LABELS = Object.freeze({
    marketplace: 'Normal store',
    dark_store: 'Dark store',
});
export const DARK_STORE_OWNER_LABELS = Object.freeze({
    platform: 'Admin',
    partner: 'Partner',
});

export const isDarkStore = (store) => String(store?.operatingModel || '').trim().toLowerCase() === DARK_STORE;

/** Has a purchase ever put this product in stock? */
export const isStocked = (food) => Boolean(food?.firstStockedAt);

/** May a customer see (and order) this product of this store at all? */
export const isVisibleToCustomers = (food, store) => !isDarkStore(store) || isStocked(food);

/** Mongo condition for one store's customer-facing products: {} for a marketplace store. */
export const stockedCondition = (store) => (isDarkStore(store) ? { firstStockedAt: { $ne: null } } : {});

/**
 * Read the store model fields an admin sent, merged over what is stored.
 * Returns undefined when neither was sent, so a partial update leaves them alone.
 * A dark store always has an owner (the admin unless told otherwise); a
 * marketplace store never does.
 */
export function normalizeStoreModelInput(body = {}, existing = {}) {
    const sentModel = body?.operatingModel !== undefined;
    const sentOwner = body?.darkStoreOwner !== undefined;
    if (!sentModel && !sentOwner) return undefined;

    let model = sentModel
        ? String(body.operatingModel ?? '').trim().toLowerCase() || DEFAULT_OPERATING_MODEL
        : (existing.operatingModel || DEFAULT_OPERATING_MODEL);
    if (!OPERATING_MODELS.includes(model)) {
        throw new ValidationError('Store model must be a normal store or a dark store');
    }
    if (model !== DARK_STORE) return { operatingModel: model, darkStoreOwner: undefined };

    let owner = sentOwner
        ? String(body.darkStoreOwner ?? '').trim().toLowerCase()
        : String(existing.darkStoreOwner || '');
    if (!owner) owner = 'platform';
    if (!DARK_STORE_OWNERS.includes(owner)) {
        throw new ValidationError('A dark store is owned by the admin or a partner');
    }
    return { operatingModel: model, darkStoreOwner: owner };
}

/**
 * Ids of every dark store, briefly cached: search and favourites span all stores
 * and ask on every request. Saving a store's model calls forgetDarkStores().
 */
let cached = null;
let cachedAt = 0;
const TTL_MS = 30 * 1000;

export async function darkStoreIds(FoodRestaurant) {
    if (cached && Date.now() - cachedAt < TTL_MS) return cached;
    const rows = await FoodRestaurant.find({ operatingModel: DARK_STORE }).select('_id').lean();
    cached = rows.map((r) => r._id);
    cachedAt = Date.now();
    return cached;
}

/** The product condition for one store's customer-facing products, by store id. */
export async function stockedConditionForStore(FoodRestaurant, storeId) {
    const ids = await darkStoreIds(FoodRestaurant);
    return ids.some((id) => String(id) === String(storeId)) ? { firstStockedAt: { $ne: null } } : {};
}

export function forgetDarkStores() {
    cached = null;
    cachedAt = 0;
}

/**
 * Narrow a product filter that spans stores: drop dark-store products that were
 * never stocked. Mutates and returns `filter`, adding to its $and so an $or the
 * caller already has is kept.
 */
export function applyStockedGate(filter, darkIds, field = 'restaurantId') {
    if (!darkIds || !darkIds.length) return filter;
    const gate = { $or: [{ [field]: { $nin: darkIds } }, { firstStockedAt: { $ne: null } }] };
    filter.$and = [...(Array.isArray(filter.$and) ? filter.$and : []), gate];
    return filter;
}
