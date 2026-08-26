import mongoose from 'mongoose';
import { ValidationError } from '../../../core/auth/errors.js';

/**
 * Add-ons chosen for one order line.
 *
 * Add-ons are a restaurant-wide pool, and a dish opts into the ones that make
 * sense for it via `addonIds`. Four things have to hold before one can be
 * charged, and the client is trusted for none of them:
 *
 *   1. the add-on belongs to the restaurant the order is with;
 *   2. it is approved, available, not deleted, and has a published version;
 *   3. THIS dish actually offers it;
 *   4. the price comes from the published record, never from the request.
 *
 * (4) is the one with money in it. Without it a crafted request could add a
 * ₹0 "Extra Cheese", or attach an add-on from a different restaurant.
 *
 * Priced per unit of the item: two burgers with extra cheese is two lots of it.
 */

const toId = (value) => String(value || '').trim();

/** Add-on ids a client asked for on one line, de-duplicated and validated in shape. */
export function normalizeRequestedAddonIds(rawLine = {}) {
    const raw = rawLine.addonIds ?? rawLine.addons ?? [];
    const list = Array.isArray(raw) ? raw : [raw];

    const ids = list
        .map((entry) => (entry && typeof entry === 'object' ? toId(entry.addonId ?? entry.id ?? entry._id) : toId(entry)))
        .filter(Boolean);

    const unique = [...new Set(ids)];
    const invalid = unique.filter((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalid.length) throw new ValidationError('One or more selected add-ons are not valid');

    return unique;
}

/**
 * Normalize the add-on list a menu-item form submitted, and refuse ids that do
 * not belong to this restaurant -- otherwise a dish could offer another shop's
 * add-on, which the order path would then reject at checkout with a confusing
 * message rather than at the point it was configured.
 *
 * Approval state is deliberately NOT required here: a restaurant may attach an
 * add-on that is still awaiting admin approval, and the order path filters on
 * approval at the moment of sale.
 *
 * Returns undefined when the caller sent nothing, so a partial update leaves the
 * stored list alone.
 */
export async function normalizeAddonIdsInput(FoodAddon, restaurantId, body = {}) {
    if (body?.addonIds === undefined) return undefined;

    const raw = Array.isArray(body.addonIds) ? body.addonIds : [body.addonIds];
    const ids = [...new Set(raw.map((v) => (v && typeof v === 'object' ? toId(v._id ?? v.id) : toId(v))).filter(Boolean))];
    if (ids.length === 0) return { addonIds: [] };

    if (ids.some((v) => !mongoose.Types.ObjectId.isValid(v))) {
        throw new ValidationError('One or more selected add-ons are not valid');
    }

    const owned = await FoodAddon.find({
        _id: { $in: ids.map((v) => new mongoose.Types.ObjectId(v)) },
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
        isDeleted: { $ne: true },
    }).select('_id').lean();

    if ((owned || []).length !== ids.length) {
        throw new ValidationError('One or more selected add-ons do not belong to this restaurant');
    }

    return { addonIds: owned.map((d) => d._id) };
}

/**
 * Turn requested ids into priced, snapshotted add-ons for a line.
 *
 * @param {object} menuItem   the dish from the database (needs name, addonIds)
 * @param {string[]} requestedIds
 * @param {Map<string, object>} addonsById  published add-on docs for this restaurant
 * @returns {{ addons: Array<{addonId: any, name: string, price: number}>, addonsTotal: number }}
 */
export function resolveLineAddons(menuItem, requestedIds = [], addonsById = new Map()) {
    if (!requestedIds.length) return { addons: [], addonsTotal: 0 };

    const label = menuItem?.name || 'This item';
    const allowed = new Set((menuItem?.addonIds || []).map((id) => String(id)));

    const addons = requestedIds.map((id) => {
        const doc = addonsById.get(String(id));
        // Same message whether the add-on is unknown, belongs to another
        // restaurant, or is withdrawn: the customer can act on it either way, and
        // it does not narrate the catalogue to someone probing ids.
        if (!doc) throw new ValidationError(`A selected add-on is no longer available for "${label}"`);

        if (!allowed.has(String(id))) {
            throw new ValidationError(`"${doc.name}" cannot be added to "${label}"`);
        }

        return {
            addonId: doc._id,
            name: doc.name,
            price: Number(doc.price) || 0,
        };
    });

    const addonsTotal = Math.round(addons.reduce((sum, a) => sum + a.price, 0) * 100) / 100;
    return { addons, addonsTotal };
}

/**
 * Load the add-ons a restaurant may currently sell, keyed by id.
 *
 * Published values only -- `draft` is what the restaurant is editing and what
 * admin has not approved, so charging from it would sell an unapproved price.
 */
export async function loadSellableAddons(FoodAddon, restaurantId, ids = []) {
    if (!ids.length) return new Map();

    const docs = await FoodAddon.find({
        _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) },
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
        isDeleted: { $ne: true },
        approvalStatus: 'approved',
        isAvailable: true,
        published: { $ne: null },
    })
        .select('_id published')
        .lean();

    return new Map(
        (docs || [])
            .filter((d) => d?.published)
            .map((d) => [String(d._id), {
                _id: d._id,
                name: d.published.name || '',
                price: Number(d.published.price) || 0,
            }])
    );
}
