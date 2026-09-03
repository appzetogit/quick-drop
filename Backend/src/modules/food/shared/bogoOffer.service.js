import { FoodBogoOffer } from '../admin/models/bogoOffer.model.js';
import {
    computeFreeUnits,
    describeBogoSaving,
    isBogoOfferLive,
    splitBogoLine,
} from './bogoOffer.js';

/**
 * Apply a restaurant's buy-one-get-one rows to an order's lines.
 *
 * Kept out of the pricing service so the same resolution serves the order path,
 * the cart preview and the menu nudge -- three callers that must agree, because a
 * customer promised a free second pizza in the cart who is then charged for it on
 * the order has been lied to by the same system twice.
 */

const EMPTY_BOGO = Object.freeze({ totalFreeUnits: 0, savings: 0, lines: [] });

/** The rows configured for a restaurant, or null. */
export async function getBogoOffer(restaurantId) {
    if (!restaurantId) return null;
    return FoodBogoOffer.findOne({ restaurantId }).lean();
}

/**
 * Split every qualifying line into its paid and free halves.
 *
 * Runs on lines that have already been through resolveAuthoritativeItems, so the
 * prices, quantities and variants here are the server's own and every dish is
 * already known to be approved and sellable. That is why nothing is re-validated
 * below: a dish the customer could not have ordered is not in this list.
 *
 * Matching is per line on the item AND its variant, which falls out of splitting
 * the line in place: a free large pizza can only ever accompany a paid large
 * pizza. A cart holding one small and one large earns nothing, which is the
 * intended reading of an offer on a dish that is sold by size.
 *
 * @param {string} restaurantId
 * @param {Array<object>} items  resolved order lines
 * @returns {{ items: Array<object>, bogo: { totalFreeUnits: number, savings: number, lines: Array<object> } }}
 */
export async function applyBogoToItems(restaurantId, items) {
    const list = Array.isArray(items) ? items : [];
    if (!restaurantId || list.length === 0) return { items: list, bogo: EMPTY_BOGO };

    const doc = await getBogoOffer(restaurantId);
    if (!doc || doc.isActive === false) return { items: list, bogo: EMPTY_BOGO };

    const now = new Date();
    const liveOffers = new Map();
    for (const offer of doc.offers || []) {
        if (!offer?.itemId) continue;
        if (!isBogoOfferLive(offer, now)) continue;
        liveOffers.set(String(offer.itemId), offer);
    }
    if (liveOffers.size === 0) return { items: list, bogo: EMPTY_BOGO };

    // Free units already granted for each dish, so a per-order cap is shared
    // across that dish's variants rather than applied afresh to each one -- two
    // lines of the same pizza must not each get the full allowance.
    const grantedByItem = new Map();

    const nextItems = [];
    const savingLines = [];
    let totalFreeUnits = 0;
    let savings = 0;

    for (const line of list) {
        const offer = liveOffers.get(String(line?.itemId || ''));

        // A line already priced at nothing is a reward some other rule granted.
        // Running this over it would split a freebie into a freebie and a freer
        // one, and would let a zero-priced unit count toward a pair it did not pay for.
        const alreadyFree = line?.isFreebie === true || line?.isBogoFree === true;

        if (!offer || alreadyFree) {
            nextItems.push(line);
            continue;
        }

        const cap = offer.maxFreeUnitsPerOrder;
        const allowance = cap === null || cap === undefined
            ? null
            : Math.max(0, Number(cap) - (grantedByItem.get(String(line.itemId)) || 0));

        const freeUnits = computeFreeUnits(line?.quantity, offer, allowance);
        if (freeUnits <= 0) {
            nextItems.push(line);
            continue;
        }

        nextItems.push(...splitBogoLine(line, freeUnits, offer));

        grantedByItem.set(
            String(line.itemId),
            (grantedByItem.get(String(line.itemId)) || 0) + freeUnits,
        );

        const saving = describeBogoSaving(line, freeUnits);
        if (saving) {
            savingLines.push(saving);
            totalFreeUnits += saving.freeQuantity;
            savings += saving.savedAmount;
        }
    }

    return {
        items: nextItems,
        bogo: {
            totalFreeUnits,
            savings: Math.round(savings * 100) / 100,
            lines: savingLines,
        },
    };
}

/**
 * Save the rows from either panel.
 *
 * Upserts on restaurantId, which is unique, so the two panels editing the same
 * restaurant cannot create rival documents.
 */
export async function saveBogoOffer(restaurantId, { offers, isActive, updatedByRole }) {
    const update = { updatedByRole: updatedByRole || 'RESTAURANT' };
    if (offers !== undefined) update.offers = offers;
    if (isActive !== undefined) update.isActive = isActive !== false;

    return FoodBogoOffer.findOneAndUpdate(
        { restaurantId },
        { $set: update, $setOnInsert: { restaurantId } },
        { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
}
