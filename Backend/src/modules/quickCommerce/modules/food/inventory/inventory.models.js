import mongoose from 'mongoose';

/**
 * Suppliers and purchase entries for grocery and fruits & vegetables stock.
 *
 * A purchase is one vendor bill. Saving it adds every line to stock (a 'purchase'
 * movement in qc_stock_movements) and makes the line's rate the product's latest
 * purchase price, which is what stock is valued at.
 */

const supplierSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 120 },
        phone: { type: String, trim: true, default: '', maxlength: 20 },
        gstin: { type: String, trim: true, default: '', maxlength: 20 },
        address: { type: String, trim: true, default: '', maxlength: 300 },
        /** What they supply, as staff describe it: "Atta, rice, oil". */
        supplies: { type: String, trim: true, default: '', maxlength: 200 },
        isActive: { type: Boolean, default: true },
    },
    { collection: 'qc_inventory_suppliers', timestamps: true },
);

const purchaseLineSchema = new mongoose.Schema(
    {
        itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
        variantId: { type: String, default: '' },
        itemName: { type: String, default: '' },
        variantName: { type: String, default: '' },
        /** One bill can carry both: each line counts toward its own section's reports. */
        section: { type: String, enum: ['grocery', 'fresh'], default: 'grocery' },
        /** In units of stock: packs for a sized product, kg for one kept by weight. */
        qty: { type: Number, required: true, min: 0 },
        /** Per unit, before GST. */
        rate: { type: Number, required: true, min: 0 },
        gstRate: { type: Number, default: 0, min: 0, max: 100 },
        taxable: { type: Number, default: 0 },
        gst: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
    },
    { _id: false },
);

const purchaseSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
        section: { type: String, enum: ['grocery', 'fresh'], default: 'grocery', index: true },
        supplierId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
        supplierName: { type: String, default: '' },
        billNo: { type: String, trim: true, default: '', maxlength: 60 },
        billDate: { type: Date, required: true, index: true },
        /** How it was paid: cash, upi, credit (owed to the supplier). */
        paidVia: { type: String, enum: ['cash', 'upi', 'bank', 'credit'], default: 'cash' },
        lines: { type: [purchaseLineSchema], default: [] },
        taxable: { type: Number, default: 0 },
        gst: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
        note: { type: String, trim: true, default: '', maxlength: 300 },
        createdBy: {
            id: { type: String, default: '' },
            name: { type: String, default: '' },
        },
    },
    { collection: 'qc_inventory_purchases', timestamps: true },
);
purchaseSchema.index({ restaurantId: 1, billDate: -1 });

export const InventorySupplier = mongoose.models.QCInventorySupplier
    || mongoose.model('QCInventorySupplier', supplierSchema);
export const InventoryPurchase = mongoose.models.QCInventoryPurchase
    || mongoose.model('QCInventoryPurchase', purchaseSchema);
