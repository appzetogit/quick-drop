import mongoose from 'mongoose';

const deliveryFeeRangeSchema = new mongoose.Schema(
    {
        min: { type: Number, required: true, min: 0 },
        max: { type: Number, required: true, min: 0 },
        fee: { type: Number, required: true, min: 0 }
    },
    { _id: false }
);

const feeSettingsSchema = new mongoose.Schema(
    {
        // No defaults here; admin must explicitly configure values.
        deliveryFee: { type: Number, min: 0 },
        deliveryFeeRanges: { type: [deliveryFeeRangeSchema], default: [] },
        deliveryFeeComputationMode: {
            type: String,
            enum: ['order_value_range', 'distance_order_value'],
            default: 'distance_order_value'
        },
        distanceOrderDeliveryFeeRules: {
            type: [
                new mongoose.Schema(
                    {
                        distanceRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodDeliveryCommissionRule', required: true },
                        priceSlabs: {
                            type: [
                                new mongoose.Schema(
                                    {
                                        minOrderValue: { type: Number, required: true, min: 0 },
                                        maxOrderValue: { type: Number, required: true, min: 0 },
                                        deliveryFee: { type: Number, required: true, min: 0 },
                                        isActive: { type: Boolean, default: true }
                                    },
                                    { _id: false }
                                )
                            ],
                            default: []
                        }
                    },
                    { _id: false }
                )
            ],
            default: []
        },
        distanceSlabAdminDeliveryCommission: {
            type: [
                new mongoose.Schema(
                    {
                        distanceRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodDeliveryCommissionRule', required: true },
                        isEnabled: { type: Boolean, default: false },
                        adminDeliveryCommissionPercent: { type: Number, min: 0, max: 100, default: 0 }
                    },
                    { _id: false }
                )
            ],
            default: []
        },
        deliveryPartnerIncentiveRule: {
            type: new mongoose.Schema(
                {
                    isEnabled: { type: Boolean, default: false },
                    minOrderAmount: { type: Number, min: 0, default: 0 },
                    incentivePercent: { type: Number, min: 0, max: 100, default: 0 }
                },
                { _id: false }
            ),
            default: {
                isEnabled: false,
                minOrderAmount: 0,
                incentivePercent: 0
            }
        },
        freeDeliveryThreshold: { type: Number, min: 0 },
        platformFee: { type: Number, min: 0 },
        gstRate: { type: Number, min: 0, max: 100 },
        codOrderLimit: { type: Number, min: 0 },
        /**
         * Platform-wide ceiling on how many of one item may be in a single order.
         *
         * An item's own maxOrderQuantity still applies and is the tighter of the
         * two; this is the cap that holds when an item sets none (0). Was a hard
         * constant of 99 in shared/orderQuantityRules.js, which stays the default
         * and the fallback whenever this is unset, so behaviour is unchanged until
         * an admin sets it. Minimum of 1 -- a ceiling of 0 would make every item
         * unorderable.
         */
        maxOrderQuantityCeiling: { type: Number, min: 1, max: 9999 },
        // Who owns the food packaging charge, and how much it is when admin owns it.
        // RESTAURANT mode reads the per-unit charge off each menu item instead
        // (see FoodItem.packagingCharge and shared/packagingCharge.js).
        packagingCharge: {
            type: new mongoose.Schema(
                {
                    isEnabled: { type: Boolean, default: false },
                    mode: { type: String, enum: ['ADMIN', 'RESTAURANT'], default: 'ADMIN' },
                    /** Flat charge added once per order in ADMIN mode. */
                    adminChargePerOrder: { type: Number, min: 0, default: 0 }
                },
                { _id: false }
            ),
            default: () => ({})
        },
        isActive: { type: Boolean, default: true, index: true }
    },
    { collection: 'food_fee_settings', timestamps: true }
);

feeSettingsSchema.index({ isActive: 1, createdAt: -1 });

export const FoodFeeSettings = mongoose.model('FoodFeeSettings', feeSettingsSchema);

