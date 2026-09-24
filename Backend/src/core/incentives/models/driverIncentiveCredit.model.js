import mongoose from 'mongoose';

/**
 * One row per (rider, rule, day) the reward was actually paid out for.
 *
 * This is the idempotency guard, not just a log: the unique index below is
 * what stops two order-completion events racing to credit the same rider
 * twice for the same day's target. Insert first, credit the wallet only if
 * the insert wins — see maybeCreditIncentive in incentiveService.js.
 *
 * driverKey is a plain string rather than an ObjectId ref because it can
 * point at three different identities depending on how this rider is
 * provisioned (a unified TaxiDriver, a standalone FoodDeliveryPartner, or a
 * standalone quick-commerce partner) — see resolveDriverContext.
 */
const driverIncentiveCreditSchema = new mongoose.Schema(
    {
        driverKey: { type: String, required: true, index: true },
        ruleId: { type: mongoose.Schema.Types.ObjectId, ref: 'DriverIncentiveRule', required: true },
        segment: { type: String, enum: ['foodAndQuick', 'taxiAndPorter'], required: true },
        periodKey: { type: String, required: true },
        completedOrders: { type: Number, required: true },
        rewardAmount: { type: Number, required: true },
        /** Which wallet path actually got the money — for support/debugging. */
        creditedVia: { type: String, enum: ['taxi_driver_wallet', 'delivery_bonus_transaction'], required: true },
    },
    { collection: 'driver_incentive_credits', timestamps: true },
);

driverIncentiveCreditSchema.index({ driverKey: 1, ruleId: 1, periodKey: 1 }, { unique: true });

export const DriverIncentiveCredit =
    mongoose.models.DriverIncentiveCredit || mongoose.model('DriverIncentiveCredit', driverIncentiveCreditSchema);
