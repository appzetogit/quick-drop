import { getFoodDisplayPrice } from '../admin/services/foodVariant.service.js';

/**
 * The Rs 99 store rule, in one place.
 *
 * A dish is on the shelf when it is approved, priced at or under the cap, and
 * flagged. The flag used to be opt-in only -- the admin ticked it by hand -- so
 * a menu full of eligible dishes showed an empty shelf until someone went
 * through them one at a time. It is now set automatically at the moments a dish
 * becomes eligible, and stays under the admin's control afterwards: unticking a
 * dish keeps it off the shelf until its price crosses the cap again.
 *
 * Every write path that can make a dish eligible calls the same helper, so the
 * rule cannot drift between admin-created, restaurant-created and approved
 * items.
 */
export const NINETY_NINE_STORE_MAX_PRICE = 99;

const toPrice = (doc) => {
    const price = Number(getFoodDisplayPrice(doc || {}));
    return Number.isFinite(price) ? price : NaN;
};

/** Priced at or under the cap. NaN and non-positive prices never qualify. */
export const isWithin99Cap = (doc) => {
    const price = toPrice(doc);
    return Number.isFinite(price) && price > 0 && price <= NINETY_NINE_STORE_MAX_PRICE;
};

/**
 * Should this dish be auto-flagged right now?
 *
 * Only when it is approved -- a pending dish flagged early would appear on the
 * shelf the moment approval landed, which is the same outcome, but a rejected
 * one must never carry the flag.
 */
export const shouldAutoMark99 = (doc) =>
    doc?.approvalStatus === 'approved' && isWithin99Cap(doc);

/**
 * Did an update move the dish INTO the cap?
 *
 * Deliberately a transition, not a state check. If it were "is it under 99
 * now", every save of an already-cheap dish would re-tick a flag the admin had
 * just cleared. Only crossing from above the cap to under it counts.
 */
export const crossedInto99Cap = (before, after) =>
    !isWithin99Cap(before) && isWithin99Cap(after);

export const __testables = { toPrice };
