import { ValidationError } from '../../../../../core/auth/errors.js';
import { isMedicalStore } from './storeType.js';

/**
 * Rules for a prescription-only order — the one a customer places by
 * photographing a doctor's prescription, with no items and no price.
 *
 * The ordinary order path cannot express this. It builds an order from catalogue
 * lines and prices it before the customer confirms; here nobody knows what is
 * being sold until the pharmacist has read the photograph. So the order is
 * created empty and priced later, by the seller, in a second step:
 *
 *   customer  photo + address        -> order, no items, total 0
 *   pharmacist reads the photo       -> approves or rejects the prescription
 *   pharmacist enters what they will dispense -> items + price land on the order
 *   pharmacist accepts               -> normal lifecycle from here on
 *
 * Two consequences fall out of that and are enforced below. The order is cash on
 * delivery, because there is nothing to charge at placement. And it may not be
 * accepted until it has been priced, or the customer would be committed to an
 * order whose cost nobody has told them.
 *
 * Pure, so the same rules serve the customer path, the seller path and the admin
 * panel without a database.
 */

/** Statuses that mean the seller has taken the order on. */
const ACCEPTANCE_STATUSES = Object.freeze(['confirmed', 'preparing', 'ready_for_pickup']);

/** Once the seller has accepted, the priced contents are fixed. */
const FILLABLE_STATUSES = Object.freeze(['created']);

export const MAX_QUOTE_ITEMS = 40;
export const MAX_QUOTE_LINE_TOTAL = 100000;

const toTrimmed = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Refuse a prescription order aimed at a seller that does not dispense medicine. */
export function assertSellerDispensesMedicine(seller) {
    if (!isMedicalStore(seller?.storeType)) {
        throw new ValidationError('This store is not a medical store, so it cannot take a prescription order.');
    }
}

/**
 * Validate and normalise the lines a pharmacist entered.
 *
 * These are not catalogue products — a pharmacist dispenses against what the
 * prescription says, which may be a brand the shop never listed. The order item
 * schema takes `itemId` as a plain string, so each line gets a synthetic id
 * scoped to this order rather than a fake catalogue reference that later joins
 * would silently follow to nothing.
 */
export function normalizeQuoteItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new ValidationError('Add at least one medicine before pricing this order.');
    }
    if (rawItems.length > MAX_QUOTE_ITEMS) {
        throw new ValidationError(`An order cannot carry more than ${MAX_QUOTE_ITEMS} lines.`);
    }

    return rawItems.map((raw, index) => {
        const name = toTrimmed(raw?.name);
        if (!name) throw new ValidationError(`Line ${index + 1}: enter the medicine name.`);
        if (name.length > 200) throw new ValidationError(`Line ${index + 1}: name is too long.`);

        const price = Number(raw?.price);
        if (!Number.isFinite(price) || price < 0) {
            throw new ValidationError(`Line ${index + 1}: enter a valid price.`);
        }

        const quantity = Number(raw?.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new ValidationError(`Line ${index + 1}: quantity must be a whole number of at least 1.`);
        }

        // Caught here rather than at the total, so the pharmacist is told which
        // line carries the typo instead of being refused with one opaque number.
        if (price * quantity > MAX_QUOTE_LINE_TOTAL) {
            throw new ValidationError(`Line ${index + 1}: that line total looks wrong. Check the price.`);
        }

        return {
            itemId: `rx-${index + 1}`,
            name,
            price: Math.round(price * 100) / 100,
            quantity,
            packSize: toTrimmed(raw?.packSize).slice(0, 60),
            notes: toTrimmed(raw?.notes).slice(0, 200),
            // A pharmacy line is not food. Left explicitly rather than defaulted,
            // because the schema's default of true would put a green veg dot on
            // a box of antibiotics.
            isVeg: false,
        };
    });
}

export function computeQuoteSubtotal(items = []) {
    const total = items.reduce((sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);
    return Math.round(total * 100) / 100;
}

/** True once a pharmacist has entered what they will dispense. */
export function isPriced(order) {
    return Boolean(
        order?.prescriptionOnly &&
        Array.isArray(order.items) &&
        order.items.length > 0 &&
        Number(order?.pricing?.total) > 0,
    );
}

/**
 * May the seller still change what this order contains?
 *
 * Only before acceptance. After that the customer has been told a price and a
 * rider may already be on the way, so a silent re-price would be a different
 * order than the one everyone agreed to.
 */
export function assertFillable(order) {
    if (!order?.prescriptionOnly) {
        throw new ValidationError('This order was not placed from a prescription photo.');
    }
    const status = String(order.orderStatus || '');
    if (!FILLABLE_STATUSES.includes(status)) {
        throw new ValidationError(
            status === 'created'
                ? 'This order can no longer be priced.'
                : `This order is already ${status.replace(/_/g, ' ')} and can no longer be priced.`,
        );
    }
}

/**
 * A prescription order may not be accepted until it has been priced.
 *
 * Without this the pharmacist could accept an empty order, and the customer
 * would be committed to a delivery whose cost nobody had told them. Cancelling
 * stays available, so an unreadable prescription is never stuck.
 */
export function assertPrescriptionOrderPriced(order, nextStatus) {
    if (!order?.prescriptionOnly) return;
    if (!ACCEPTANCE_STATUSES.includes(String(nextStatus || ''))) return;
    if (!isPriced(order)) {
        throw new ValidationError(
            'Enter the medicines and price for this prescription before accepting the order.',
        );
    }
}
