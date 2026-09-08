import mongoose from 'mongoose';

/**
 * What a dish was priced at immediately before a global adjustment run.
 *
 * Adjustments used to be undone by replaying the inverse factor, which needs
 * nothing stored. Neither direction can be any more, because neither is a
 * multiply: a markdown promotes the selling price to the strike-through, and an
 * increase SETS the comparison to a percentage above today's price rather than
 * scaling the figure it last wrote. A dish at Rs 200 struck from Rs 250 becomes
 * Rs 180 struck from Rs 200, and the 250 is gone; a dish whose comparison is
 * rewritten to Rs 240 no longer remembers the Rs 216 it displayed before.
 * Dividing by the factor cannot recover either.
 *
 * So a run of any direction is snapshotted, and revert restores rather than
 * divides. Runs recorded before this carry no snapshot and still fall back to
 * the inverse multiply.
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
        // The comparison figure, which both directions now overwrite rather
        // than scale, so it cannot be undone by an inverse multiply either.
        otherPrice: { type: Number, default: 0 },
        // Every size, since a markdown moves those too.
        variants: { type: [{ _id: mongoose.Schema.Types.ObjectId, price: Number }], default: [] },
    },
    { collection: 'food_price_adjustment_snapshots', timestamps: true },
);

// A run is written and read as a whole, and cleaned up as a whole.
priceAdjustmentSnapshotSchema.index({ adjustmentId: 1, itemId: 1 });

export const FoodPriceAdjustmentSnapshot = mongoose.models.FoodPriceAdjustmentSnapshot
    || mongoose.model('FoodPriceAdjustmentSnapshot', priceAdjustmentSnapshotSchema);
