import mongoose from 'mongoose';

const foodVariantSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        petpoojaVariantId: { type: String, trim: true, default: '' }
    },
    { _id: true }
);

const foodSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodCategory', index: true },
        categoryName: { type: String, trim: true, default: '' },
        name: { type: String, required: true, trim: true, index: true },
        description: { type: String, trim: true, default: '' },
        price: { type: Number, required: true, min: 0 },
        /**
         * Printed maximum retail price, shown struck through next to `price`.
         * Selling above it is illegal, so it is a constraint the server enforces,
         * not a marketing number. null means "not recorded", which is what every
         * row that predates this field is -- treating absent as 0 would make them
         * all look like they were being sold above MRP. See shared/mrpPricing.js.
         */
        mrp: { type: Number, min: 0, default: null },
        variants: { type: [foodVariantSchema], default: [] },
        image: { type: String, trim: true, default: '' },
        foodType: { type: String, enum: ['Veg', 'Non-Veg'], default: 'Non-Veg' },
        isActive: { type: Boolean, default: true, index: true },
        isAvailable: { type: Boolean, default: true, index: true },
        isRecommended: { type: Boolean, default: false, index: true },
        preparationTime: { type: String, trim: true, default: '' },
        /**
         * Per-item order quantity limits, enforced server-side by
         * shared/orderQuantityRules.js. `maxOrderQuantity: 0` means no item cap.
         */
        minOrderQuantity: { type: Number, min: 1, default: 1 },
        maxOrderQuantity: { type: Number, min: 0, default: 0 },
        /**
         * Per-unit packaging charge, used only when admin runs packaging in
         * RESTAURANT mode. See shared/packagingCharge.js.
         */
        packagingCharge: {
            isEnabled: { type: Boolean, default: false },
            amount: { type: Number, min: 0, default: 0 }
        },
        /**
         * Optional per-item availability windows, e.g. breakfast served 08:00-11:30.
         * Disabled by default, so an item without one is always orderable.
         * Times are wall-clock in `timezone`; see shared/itemAvailability.js.
         */
        availabilitySchedule: {
            isEnabled: { type: Boolean, default: false },
            timezone: { type: String, trim: true, default: 'Asia/Kolkata' },
            days: {
                type: [
                    new mongoose.Schema(
                        {
                            day: {
                                type: String,
                                enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
                                required: true
                            },
                            isAvailable: { type: Boolean, default: true },
                            startTime: { type: String, trim: true, default: '09:00' },
                            endTime: { type: String, trim: true, default: '22:00' }
                        },
                        { _id: false }
                    )
                ],
                default: []
            }
        },
        approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
        rejectionReason: { type: String, trim: true, default: '' },
        requestedAt: { type: Date },
        approvedAt: { type: Date },
        rejectedAt: { type: Date },
        petpoojaItemId: { type: String, trim: true, default: '' }
    },
    {
        collection: 'food_items',
        timestamps: true
    }
);

foodSchema.index({ restaurantId: 1, createdAt: -1 });
foodSchema.index({ approvalStatus: 1, createdAt: -1 });
foodSchema.index({ approvalStatus: 1, requestedAt: -1 });
foodSchema.index({ restaurantId: 1, approvalStatus: 1, createdAt: -1 });

export const FoodItem = mongoose.model('FoodItem', foodSchema);
