import mongoose from 'mongoose';

/**
 * Audit trail for global menu price adjustments.
 *
 * The adjustment is applied as a real write to every matched FoodItem rather
 * than as a multiplier read at display time. That is deliberate: prices are
 * read by the menu, the cart, checkout, and the invoice through several
 * separate code paths, and a read-time multiplier that any one of them missed
 * would show the customer one price and charge them another.
 *
 * This log exists so an adjustment can be reviewed and reverted.
 */
const priceAdjustmentSchema = new mongoose.Schema(
    {
        /** Signed percent applied, e.g. 10 for +10%, -15 for a 15% cut. */
        percent: { type: Number, required: true },
        /** Multiplier actually used (1 + percent/100). Stored so a revert is exact. */
        factor: { type: Number, required: true, min: 0 },
        /** Null means the adjustment covered every restaurant. */
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', default: null },
        restaurantName: { type: String, trim: true, default: 'All restaurants' },
        itemsUpdated: { type: Number, default: 0 },
        // How many of those were held at their MRP instead of taking the full
        // percentage. Recorded so the history explains a run that did less than
        // the percent suggests.
        itemsCappedByMrp: { type: Number, default: 0 },
        /** Set when this entry is itself the undo of an earlier adjustment. */
        revertsAdjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodPriceAdjustment', default: null },
        isReverted: { type: Boolean, default: false },
        appliedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        appliedByName: { type: String, trim: true, default: '' }
    },
    { collection: 'food_price_adjustments', timestamps: true }
);

priceAdjustmentSchema.index({ createdAt: -1 });

export const FoodPriceAdjustment = mongoose.model('FoodPriceAdjustment', priceAdjustmentSchema);
