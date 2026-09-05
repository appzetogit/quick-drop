import mongoose from 'mongoose';

/**
 * What a dish was priced at immediately before a markdown run.
 *
 * The other global adjustments are undone by replaying the inverse factor,
 * which needs nothing stored. A markdown cannot be: it promotes the selling
 * price to the strike-through, so the dish's previous pre-discount price is
 * overwritten and no amount of multiplying brings it back. A dish at Rs 200
 * struck from Rs 250 becomes Rs 180 struck from Rs 200, and the 250 is gone.
 *
 * One row per affected dish per run. Written before the update, so a crash
 * midway leaves a snapshot that reverts more than happened rather than less --
 * restoring a dish to a price it already had is harmless, failing to restore
 * one is not.
 */
const priceAdjustmentSnapshotSchema = new mongoose.Schema(
    {
        adjustmentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodPriceAdjustment',
            required: true,
            index: true,
        },
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem', required: true },
        price: { type: Number, required: true },
        // Null is meaningful and must round-trip: rows predating basePrice have
        // none, and readers treat that as "base equals price".
        basePrice: { type: Number, default: null },
        discountPercent: { type: Number, default: 0 },
        // Every size, since a markdown moves those too.
        variants: { type: [{ _id: mongoose.Schema.Types.ObjectId, price: Number }], default: [] },
    },
    { collection: 'food_price_adjustment_snapshots', timestamps: true },
);

// A run is written and read as a whole, and cleaned up as a whole.
priceAdjustmentSnapshotSchema.index({ adjustmentId: 1, itemId: 1 });

export const FoodPriceAdjustmentSnapshot = mongoose.models.FoodPriceAdjustmentSnapshot
    || mongoose.model('FoodPriceAdjustmentSnapshot', priceAdjustmentSnapshotSchema);
