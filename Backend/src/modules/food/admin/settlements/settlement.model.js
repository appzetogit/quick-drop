import mongoose from 'mongoose';

/**
 * One restaurant's settlement for one 10-day cycle (1-10, 11-20, 21-end of month).
 *
 * Created the first time the admin pays (or holds) that cycle. From then on its
 * bills are locked to this settlement: an order can be in one settlement only
 * (unique index on lines.orderId), so the same bill cannot be paid twice. Orders
 * of the period delivered after the lock join it at the next payment.
 *
 * The bill lines are a snapshot of the payout ledger (food_transactions) at lock
 * time, so a statement printed later shows what was paid against.
 */
const lineSchema = new mongoose.Schema(
    {
        orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodOrder', required: true },
        orderNo: { type: String, default: '' },
        orderDate: { type: Date },
        basic: { type: Number, default: 0 },
        packing: { type: Number, default: 0 },
        gst: { type: Number, default: 0 },
        billTotal: { type: Number, default: 0 },
        commission: { type: Number, default: 0 },
        /** GST the platform keeps to pay the government, and coupons the restaurant funded. */
        deductions: { type: Number, default: 0 },
        payable: { type: Number, default: 0 },
        paymentMethod: { type: String, default: '' },
    },
    { _id: false },
);

const paymentSchema = new mongoose.Schema(
    {
        amount: { type: Number, required: true, min: 0.01 },
        mode: { type: String, enum: ['upi', 'bank_transfer', 'cash'], required: true },
        utr: { type: String, trim: true, default: '' },
        paidOn: { type: Date, required: true },
        officerId: { type: String, default: '' },
        officerName: { type: String, default: '' },
        note: { type: String, trim: true, default: '' },
        /** The approved withdrawal that records this payment in the restaurant's wallet. */
        withdrawalId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurantWithdrawal' },
        /** Sent by the screen once per click, so a double click or a retry pays once. */
        requestId: { type: String, default: '' },
        recordedBy: { id: { type: String, default: '' }, name: { type: String, default: '' } },
        recordedAt: { type: Date, default: Date.now },
    },
    { _id: true },
);

const settlementSchema = new mongoose.Schema(
    {
        settlementNo: { type: String, required: true, unique: true },
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        restaurantName: { type: String, default: '' },
        cycleKey: { type: String, required: true }, // 2026-11-1
        year: { type: Number, required: true },
        month: { type: Number, required: true }, // 1-12
        cycle: { type: Number, required: true }, // 1, 2, 3
        periodStart: { type: Date, required: true },
        periodEnd: { type: Date, required: true },
        label: { type: String, default: '' },
        lines: { type: [lineSchema], default: [] },
        totals: {
            orders: { type: Number, default: 0 },
            basic: { type: Number, default: 0 },
            packing: { type: Number, default: 0 },
            gst: { type: Number, default: 0 },
            billTotal: { type: Number, default: 0 },
            commission: { type: Number, default: 0 },
            deductions: { type: Number, default: 0 },
            payable: { type: Number, default: 0 },
        },
        /** Unpaid balance brought in from earlier settlements of this restaurant. */
        carriedIn: { type: Number, default: 0 },
        carriedFrom: { type: [String], default: [] },
        /** Unpaid balance moved on to a later settlement, which now owes it. */
        carriedOut: { type: Number, default: 0 },
        carriedTo: { type: String, default: '' },
        paid: { type: Number, default: 0 },
        payments: { type: [paymentSchema], default: [] },
        onHold: { type: Boolean, default: false },
        holdNote: { type: String, default: '' },
        lockedAt: { type: Date, default: Date.now },
        lockedBy: { id: { type: String, default: '' }, name: { type: String, default: '' } },
    },
    { collection: 'food_restaurant_settlements', timestamps: true },
);

settlementSchema.index({ restaurantId: 1, cycleKey: 1 }, { unique: true });
settlementSchema.index({ cycleKey: 1 });
// A bill belongs to one settlement, ever.
settlementSchema.index({ 'lines.orderId': 1 }, { unique: true, partialFilterExpression: { 'lines.orderId': { $exists: true } } });
settlementSchema.index({ 'payments.utr': 1 });
settlementSchema.index({ 'payments.requestId': 1 });

export const FoodRestaurantSettlement = mongoose.models.FoodRestaurantSettlement
    || mongoose.model('FoodRestaurantSettlement', settlementSchema, 'food_restaurant_settlements');
