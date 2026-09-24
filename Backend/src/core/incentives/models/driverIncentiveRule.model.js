import mongoose from 'mongoose';

/**
 * An admin-configured "complete N orders, get ₹X" target for one duty
 * segment — mirrors the Flutter rider app's DutySegment split:
 *   - foodAndQuick: food, quick-commerce and medicine deliveries.
 *   - taxiAndPorter: rides and parcel/porter jobs.
 *
 * Edits insert a new active version and deactivate the previous one (see
 * upsertIncentiveRuleController in incentiveController.js) rather than
 * mutating in place — same "latest active wins" pattern as FoodFeeSettings —
 * so a concurrent read never sees a half-written rule, and history isn't
 * destroyed on edit.
 */
const driverIncentiveRuleSchema = new mongoose.Schema(
    {
        segment: {
            type: String,
            enum: ['foodAndQuick', 'taxiAndPorter'],
            required: true,
            index: true,
        },
        /** Admin-authored headline shown as-is on the rider's card. */
        title: { type: String, trim: true, default: '' },
        targetOrders: { type: Number, required: true, min: 1 },
        rewardAmount: { type: Number, required: true, min: 0 },
        /** Only 'daily' today; kept as a field rather than a bare boolean so a
         *  weekly/monthly window can be added later without a schema change. */
        windowType: { type: String, enum: ['daily'], default: 'daily' },
        isActive: { type: Boolean, default: true, index: true },
        createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },
    { collection: 'driver_incentive_rules', timestamps: true },
);

driverIncentiveRuleSchema.index({ segment: 1, isActive: 1, createdAt: -1 });

export const DriverIncentiveRule =
    mongoose.models.DriverIncentiveRule || mongoose.model('DriverIncentiveRule', driverIncentiveRuleSchema);
