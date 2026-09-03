import mongoose from 'mongoose';

const foodVariantSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        /**
         * Add-ons offered only when this variant is chosen -- extra cheese on
         * the large, but not the small.
         *
         * Added to the item's own list rather than replacing it, so an add-on
         * that applies to every size is still set once on the item. An empty
         * list therefore means 'nothing extra for this size', not 'no add-ons',
         * which is what every existing variant is.
         */
        addonIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodAddon' }],
            default: [],
        },
        /**
         * The same pairings, with a price for THIS size.
         *
         * The price of an add-on is really the price of a pairing: extra cheese
         * on a large burger is more cheese than on a small one, so one figure on
         * the add-on record cannot be right for both. `price: null` means "use
         * the add-on's own price", which is what every pairing made before this
         * field, and the fallback whenever a restaurant does not care.
         *
         * addonIds above is kept in step as a plain list of the same ids --
         * every reader that only asks "is this add-on allowed here?" keeps
         * working unchanged, and only pricing consults this array.
         */
        addons: {
            type: [new mongoose.Schema(
                {
                    addonId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodAddon', required: true },
                    price: { type: Number, min: 0, default: null },
                },
                { _id: false }
            )],
            default: [],
        },
        /**
         * Optional per-variant order quantity limits.
         *
         * Sizes do not sell alike: a half plate might reasonably go out in ones
         * while a family pack is capped at two, and eggs sold by the piece can
         * carry a minimum the boxed size should not inherit. Before this, one
         * pair of limits covered every size of a dish.
         *
         * null means "not set for this size" -- the dish's own limit applies.
         * Each bound falls back independently, so a variant may set only a
         * maximum and keep the dish's minimum.
         */
        minOrderQuantity: { type: Number, min: 1, default: null },
        maxOrderQuantity: { type: Number, min: 0, default: null },
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
         * What the dish is worth before any discount -- the number struck
         * through next to `price`.
         *
         * `price` remains the selling price and stays authoritative: order
         * subtotals, commission and payouts all read it, so pricing an item
         * this way does not change any of that code. Commission therefore
         * lands on what the customer actually pays, not on this sticker.
         *
         * null means the row predates the field. Readers treat that as
         * 'undiscounted, base equals price' rather than as 0, which would make
         * every legacy item look like it was being given away.
         * See shared/itemDiscountPricing.js.
         */
        basePrice: { type: Number, min: 0, default: null },
        discountPercent: { type: Number, min: 0, max: 100, default: 0 },
        /**
         * Printed maximum retail price, shown struck through next to `price`.
         * Selling above it is illegal, so it is a constraint the server enforces,
         * not a marketing number. null means "not recorded", which is what every
         * row that predates this field is -- treating absent as 0 would make them
         * all look like they were being sold above MRP. Retired; see itemDiscountPricing.js.
         */
        /** Retired in favour of basePrice/discountPercent; kept so existing rows are not erased. No longer written by the item forms. */
        mrp: { type: Number, min: 0, default: null },
        /**
         * Compare-at / other-platform price, struck through next to `price` when
         * it is higher. Purely presentational, so unlike `mrp` it is NOT a
         * constraint: a restaurant may legitimately be cheaper than the rival
         * price they typed, and refusing that would be nonsense. Existing items
         * stay 0, which the clients already read as "nothing to strike through".
         */
        /** Retired alongside `mrp`; see above. */
        otherPrice: { type: Number, min: 0, default: 0 },
        /**
         * Whether this dish is sold by its variants.
         *
         * ON: each variant carries its own price (and add-on pairings), and the
         * item's price is the cheapest of them -- the "from" figure a listing
         * shows. OFF: the base price is what is charged, and the variants array
         * is RETAINED rather than cleared, so switching back on does not mean
         * retyping every size. The order path ignores a client-sent variantId
         * while this is off, so a stale cart line is charged the base price
         * instead of failing the order.
         */
        variantsEnabled: { type: Boolean, default: false },
        variants: { type: [foodVariantSchema], default: [] },
        /**
         * Which of the restaurant's add-ons may be chosen with THIS dish.
         *
         * Add-ons are a restaurant-wide pool, which meant every dish offered every
         * add-on -- extra raita on a milkshake. This narrows the pool per item.
         *
         * An empty list means the dish takes no add-ons, not "all of them". That
         * is the safe reading: every existing item has an empty list, so nothing
         * silently gains options nobody chose for it.
         */
        addonIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodAddon' }],
            default: [],
        },
        image: { type: String, trim: true, default: '' },
        foodType: { type: String, enum: ['Veg', 'Non-Veg'], default: 'Non-Veg' },
        isActive: { type: Boolean, default: true, index: true },
        isAvailable: { type: Boolean, default: true, index: true },
        isRecommended: { type: Boolean, default: false, index: true },
        /**
         * Admin-curated shelf for the Rs 99 store in the app. The admin decides
         * which dishes are eligible; the price ceiling is enforced separately at
         * read time, so a dish that later rises above Rs 99 drops out of the
         * shelf on its own rather than needing the flag cleared by hand.
         */
        showIn99Store: { type: Boolean, default: false, index: true },
        /**
         * Admin-set: this dish ships without a delivery charge. Waiving the fee is
         * the platform's cost to bear, not the restaurant's, so the restaurant
         * panel never sets it.
         */
        freeDelivery: { type: Boolean, default: false, index: true },
        /**
         * Combos: this dish is a bundle of other dishes on the same menu, sold as
         * one line at one fixed price.
         *
         * A combo is a FoodItem rather than its own collection so that the menu,
         * the cart, order pricing, commission and the POS all handle it as the
         * dish the customer thinks it is. `price` is the combo price and
         * `basePrice` is what the components cost separately, which is what makes
         * the saving render through the existing struck-through-price display.
         *
         * Components are snapshotted by name and price at save time: a kitchen
         * ticket printed next year must stay readable after a component has been
         * renamed, repriced or removed.
         */
        isCombo: { type: Boolean, default: false, index: true },
        comboComponents: {
            type: [new mongoose.Schema(
                {
                    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem', required: true },
                    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
                    quantity: { type: Number, min: 1, default: 1 },
                    nameSnapshot: { type: String, trim: true, default: '' },
                    variantNameSnapshot: { type: String, trim: true, default: '' },
                    listUnitPrice: { type: Number, min: 0, default: 0 },
                    allocatedLineTotal: { type: Number, min: 0, default: 0 }
                },
                { _id: false }
            )],
            default: []
        },
        /**
         * Set when a combo was taken off the menu automatically because one of its
         * components went unavailable -- never when a person switched it off. Only
         * an automatic disable is automatically undone, so a deliberately parked
         * combo stays parked when its components come back.
         */
        comboAutoDisabled: { type: Boolean, default: false },
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
