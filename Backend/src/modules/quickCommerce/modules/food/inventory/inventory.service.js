import mongoose from 'mongoose';
import { FoodItem } from '../admin/models/food.model.js';
import { QCStockMovement } from '../admin/models/stockMovement.model.js';
import { FoodRestaurant } from '../restaurant/models/restaurant.model.js';
import { InventorySupplier, InventoryPurchase } from './inventory.models.js';
import { adjustStock, listStock } from '../admin/services/stock.service.js';
import { invalidateStockCaches, stockPerSale, parseUnitsInName } from '../orders/services/inventory.service.js';
import { ValidationError } from '../../../core/auth/errors.js';
import { ApiError } from '../../../../../utils/ApiError.js';

/**
 * Inventory for grocery and fruits & vegetables (Admin > Quick Commerce > Inventory).
 *
 * Stock counts and their history are the existing ones (stock.service.js,
 * qc_stock_movements); this adds what a shop's back office needs around them:
 * suppliers, vendor-bill purchase entries that fill stock, wastage with a
 * reason, a daily sheet for produce bought and priced by weight, bulk price
 * changes, and the dashboard and reports built from the stock history.
 *
 * Every number in the reports is read from qc_stock_movements and
 * qc_inventory_purchases, so a figure always traces back to its entries.
 */

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const tracked = (v) => v !== null && v !== undefined;

export const SECTIONS = ['grocery', 'fresh'];
export const WASTE_REASONS = ['spoiled', 'damaged', 'expired', 'other'];
const PAID_VIA = ['cash', 'upi', 'bank', 'credit'];

const sectionOf = (value) => (value === 'fresh' ? 'fresh' : 'grocery');
const sectionFilter = (section) => (section === 'fresh' ? { section: 'fresh' } : { section: { $ne: 'fresh' } });

const IST_MS = (5 * 60 + 30) * 60 * 1000;
/** Midnight in India, `daysAgo` days back. */
const istDayStart = (daysAgo = 0, now = new Date()) => {
    const d = new Date(now.getTime() + IST_MS);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysAgo) - IST_MS);
};
const istDayKey = (date) => new Date(new Date(date).getTime() + IST_MS).toISOString().slice(0, 10);

const actorOf = (actor) => actor || { role: 'admin', id: '', name: 'Admin' };

async function storeIdsOrThrow(restaurantId) {
    if (!restaurantId) return null;
    if (!isId(restaurantId)) throw new ValidationError('Pick a valid store');
    return oid(restaurantId);
}

async function itemIdsOf({ restaurantId, section }) {
    const filter = { ...sectionFilter(section) };
    if (restaurantId) filter.restaurantId = oid(restaurantId);
    return FoodItem.distinct('_id', filter);
}

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export async function listSuppliers({ restaurantId } = {}) {
    const suppliers = await InventorySupplier.find({}).sort({ isActive: -1, name: 1 }).lean();
    const monthStart = (() => {
        const d = new Date(Date.now() + IST_MS);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_MS);
    })();
    const match = { supplierId: { $in: suppliers.map((s) => s._id) } };
    if (restaurantId && isId(restaurantId)) match.restaurantId = oid(restaurantId);
    const stats = await InventoryPurchase.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$supplierId',
                thisMonth: { $sum: { $cond: [{ $gte: ['$billDate', monthStart] }, '$total', 0] } },
                onCredit: { $sum: { $cond: [{ $eq: ['$paidVia', 'credit'] }, '$total', 0] } },
                lastBillAt: { $max: '$billDate' },
            },
        },
    ]);
    const byId = new Map(stats.map((s) => [String(s._id), s]));
    return suppliers.map((s) => {
        const st = byId.get(String(s._id)) || {};
        return {
            id: String(s._id),
            name: s.name,
            phone: s.phone,
            gstin: s.gstin,
            address: s.address,
            supplies: s.supplies,
            isActive: s.isActive !== false,
            thisMonth: round2(st.thisMonth),
            onCredit: round2(st.onCredit),
            lastBillAt: st.lastBillAt || null,
        };
    });
}

export async function saveSupplier(body = {}, id = null) {
    const name = String(body.name || '').trim();
    if (!id && !name) throw new ValidationError('Supplier name is required');
    const fields = {};
    for (const key of ['name', 'phone', 'gstin', 'address', 'supplies']) {
        if (body[key] !== undefined) fields[key] = String(body[key] || '').trim();
    }
    if (fields.name === '') throw new ValidationError('Supplier name is required');
    if (body.isActive !== undefined) fields.isActive = body.isActive !== false;
    if (!id) return (await InventorySupplier.create(fields)).toObject();
    if (!isId(id)) throw new ValidationError('Unknown supplier');
    const updated = await InventorySupplier.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();
    if (!updated) throw new ApiError(404, 'Supplier not found');
    return updated;
}

/* ------------------------------------------------------------------ */
/* Purchases                                                           */
/* ------------------------------------------------------------------ */

export async function listPurchases({ restaurantId, section, limit = 30 } = {}) {
    const filter = {};
    if (restaurantId && isId(restaurantId)) filter.restaurantId = oid(restaurantId);
    if (section) filter.section = sectionOf(section);
    const rows = await InventoryPurchase.find(filter)
        .sort({ billDate: -1, createdAt: -1 })
        .limit(Math.min(200, Math.max(1, Number(limit) || 30)))
        .lean();
    return rows.map((p) => ({
        id: String(p._id),
        section: p.section,
        supplierName: p.supplierName,
        billNo: p.billNo,
        billDate: p.billDate,
        paidVia: p.paidVia,
        lines: p.lines.length,
        taxable: p.taxable,
        gst: p.gst,
        total: p.total,
        createdAt: p.createdAt,
    }));
}

/**
 * One vendor bill. Every line is checked before anything is written, so a bad
 * line refuses the whole bill instead of leaving half of it in stock.
 */
export async function createPurchase(body = {}, actor = null) {
    const restaurantId = await storeIdsOrThrow(body.restaurantId);
    if (!restaurantId) throw new ValidationError('Pick the store the goods came into');
    const store = await FoodRestaurant.findById(restaurantId).select('restaurantName').lean();
    if (!store) throw new ValidationError('Store not found');

    let supplier = null;
    if (body.supplierId) {
        if (!isId(body.supplierId)) throw new ValidationError('Unknown supplier');
        supplier = await InventorySupplier.findById(body.supplierId).lean();
        if (!supplier) throw new ValidationError('Supplier not found');
    }
    const billDate = body.billDate ? new Date(body.billDate) : new Date();
    if (Number.isNaN(billDate.getTime())) throw new ValidationError('Bill date is not a date');
    const paidVia = PAID_VIA.includes(body.paidVia) ? body.paidVia : 'cash';
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    if (!rawLines.length) throw new ValidationError('Add at least one product to the purchase');
    if (rawLines.length > 300) throw new ValidationError('A purchase can have at most 300 lines');

    const items = await FoodItem.find({ _id: { $in: rawLines.filter((l) => isId(l?.itemId)).map((l) => oid(l.itemId)) } })
        .select('name restaurantId variants section gstRate purchaseGstRate unit')
        .lean();
    const byId = new Map(items.map((d) => [String(d._id), d]));

    const lines = rawLines.map((raw, i) => {
        const at = `Line ${i + 1}`;
        const doc = byId.get(String(raw?.itemId || ''));
        if (!doc) throw new ValidationError(`${at}: product not found`);
        if (String(doc.restaurantId) !== String(restaurantId)) throw new ValidationError(`${at}: ${doc.name} belongs to another store`);
        const variantId = raw?.variantId ? String(raw.variantId) : '';
        const variant = variantId ? (doc.variants || []).find((v) => String(v._id) === variantId) : null;
        if (variantId && !variant) throw new ValidationError(`${at}: that size of ${doc.name} no longer exists`);
        const qty = round3(raw?.qty);
        if (!(qty > 0)) throw new ValidationError(`${at}: enter the quantity received`);
        const billedRate = round2(raw?.rate);
        if (!(billedRate >= 0) || !Number.isFinite(billedRate)) throw new ValidationError(`${at}: enter the purchase rate`);
        const gstRaw = raw?.gstRate ?? doc.purchaseGstRate ?? (variant?.gstRate ?? doc.gstRate) ?? 0;
        const gstRate = Number(gstRaw);
        if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) throw new ValidationError(`${at}: GST must be 0 to 100`);
        // Some vendors bill a price with GST already in it: the rate kept is before GST,
        // and the line total stays exactly what the bill says.
        const rateIncludesGst = raw?.rateIncludesGst === undefined ? body.ratesIncludeGst === true : raw.rateIncludesGst === true;
        const rate = rateIncludesGst ? round2(billedRate / (1 + gstRate / 100)) : billedRate;
        // A size with no count of its own fills the product's (a 5 kg bag of a
        // product kept in kg adds 5). The rate stays per bag as billed.
        const ownCount = variant && tracked(variant.stockQty);
        const stockUnits = variant && !ownCount ? round3(qty * stockPerSale(doc, variantId)) : qty;
        const billedTotal = rateIncludesGst ? round2(qty * billedRate) : null;
        const taxable = rateIncludesGst ? round2(billedTotal / (1 + gstRate / 100)) : round2(qty * rate);
        const gst = rateIncludesGst ? round2(billedTotal - taxable) : round2((taxable * gstRate) / 100);
        return {
            doc, variant, ownCount, stockUnits,
            itemId: doc._id, variantId, itemName: doc.name, variantName: variant?.name || '', section: sectionOf(doc.section),
            qty, rate, billedRate, rateIncludesGst, gstRate, taxable, gst, total: round2(taxable + gst),
        };
    });

    const totals = lines.reduce((t, l) => ({ taxable: t.taxable + l.taxable, gst: t.gst + l.gst }), { taxable: 0, gst: 0 });
    const purchase = await InventoryPurchase.create({
        restaurantId,
        section: sectionOf(lines[0].doc.section),
        supplierId: supplier?._id || null,
        supplierName: supplier?.name || String(body.supplierName || '').trim(),
        billNo: String(body.billNo || '').trim(),
        billDate,
        paidVia,
        lines: lines.map(({ itemId, variantId, itemName, variantName, section, qty, rate, billedRate, rateIncludesGst, gstRate, taxable, gst, total }) =>
            ({ itemId, variantId, itemName, variantName, section, qty, rate, billedRate, rateIncludesGst, gstRate, taxable, gst, total })),
        taxable: round2(totals.taxable),
        gst: round2(totals.gst),
        total: round2(totals.taxable + totals.gst),
        note: String(body.note || '').trim(),
        createdBy: { id: String(actor?.id || ''), name: String(actor?.name || '') },
    });

    const note = [purchase.billNo ? `Bill ${purchase.billNo}` : 'Purchase', purchase.supplierName].filter(Boolean).join(' · ');
    for (const l of lines) {
        const onVariant = Boolean(l.variant && l.ownCount);
        // Cost per unit of the count that moves: per pack, or per kg for a weighed product.
        const unitCost = onVariant || !l.variant ? l.rate : round2(l.rate / (stockPerSale(l.doc, l.variantId) || 1));
        await adjustStock({
            itemId: String(l.itemId),
            variantId: onVariant ? l.variantId : '',
            mode: 'add',
            value: l.stockUnits,
            reason: 'purchase',
            note,
            unitCost,
            purchaseId: purchase._id,
            actor: actorOf(actor),
        });
        // The bill's rate is the product's purchase price from now on.
        if (l.variant) {
            await FoodItem.updateOne(
                { _id: l.itemId, 'variants._id': l.variant._id },
                { $set: { 'variants.$.purchasePrice': l.rate, purchaseGstRate: l.gstRate, ...(l.ownCount ? {} : { purchasePrice: unitCost }) } },
            );
        } else {
            await FoodItem.updateOne({ _id: l.itemId }, { $set: { purchasePrice: l.rate, purchaseGstRate: l.gstRate } });
        }
    }
    invalidateStockCaches(restaurantId);
    return { id: String(purchase._id), total: purchase.total, lines: lines.length };
}

/* ------------------------------------------------------------------ */
/* Wastage                                                             */
/* ------------------------------------------------------------------ */

export async function recordWastage(body = {}, actor = null) {
    if (!isId(body.itemId)) throw new ValidationError('Pick the product');
    const qty = round3(body.qty);
    if (!(qty > 0)) throw new ValidationError('Enter how much was wasted');
    const reason = WASTE_REASONS.includes(body.reason) ? body.reason : 'other';
    const doc = await FoodItem.findById(body.itemId).select('variants purchasePrice').lean();
    if (!doc) throw new ApiError(404, 'Product not found');
    const variantId = body.variantId ? String(body.variantId) : '';
    const variant = variantId ? (doc.variants || []).find((v) => String(v._id) === variantId) : null;
    const onVariant = Boolean(variant && tracked(variant.stockQty));
    return adjustStock({
        itemId: String(body.itemId),
        variantId: onVariant ? variantId : '',
        mode: 'add',
        value: -qty,
        reason: 'wastage',
        wasteReason: reason,
        note: String(body.note || '').trim(),
        unitCost: onVariant ? (variant.purchasePrice ?? null) : (doc.purchasePrice ?? null),
        restaurantId: body.restaurantId && isId(body.restaurantId) ? body.restaurantId : null,
        actor: actorOf(actor),
    });
}

/* ------------------------------------------------------------------ */
/* Fruits & vegetables: the daily sheet                                */
/* ------------------------------------------------------------------ */

async function todaysMoves(itemIds, from) {
    if (!itemIds.length) return new Map();
    const rows = await QCStockMovement.aggregate([
        { $match: { itemId: { $in: itemIds }, createdAt: { $gte: from } } },
        { $group: { _id: { item: '$itemId', reason: '$reason' }, delta: { $sum: '$delta' } } },
    ]);
    const map = new Map();
    for (const r of rows) {
        const key = String(r._id.item);
        const m = map.get(key) || { all: 0, purchase: 0, sale: 0, back: 0, wastage: 0 };
        m.all += r.delta;
        if (r._id.reason === 'purchase') m.purchase += r.delta;
        else if (r._id.reason === 'sale') m.sale += r.delta;
        else if (r._id.reason === 'cancel' || r._id.reason === 'return') m.back += r.delta;
        else if (r._id.reason === 'wastage') m.wastage += r.delta;
        map.set(key, m);
    }
    return map;
}

export async function freshSheet({ restaurantId } = {}) {
    const filter = { section: 'fresh' };
    if (restaurantId) {
        if (!isId(restaurantId)) throw new ValidationError('Pick a valid store');
        filter.restaurantId = oid(restaurantId);
    }
    const docs = await FoodItem.find(filter)
        .select('name restaurantId image images categoryName price previousPrice purchasePrice unit stockQty isAvailable stockOffMode seasonalUntil variants variantsEnabled')
        .sort({ name: 1 })
        .limit(1000)
        .lean();
    const moves = await todaysMoves(docs.map((d) => d._id), istDayStart(0));
    return {
        date: istDayKey(new Date()),
        rows: docs.map((d) => {
            const m = moves.get(String(d._id)) || { all: 0, purchase: 0, sale: 0, back: 0, wastage: 0 };
            const remaining = tracked(d.stockQty) ? Number(d.stockQty) : null;
            return {
                itemId: String(d._id),
                restaurantId: String(d.restaurantId),
                name: d.name,
                image: d.image || (Array.isArray(d.images) ? d.images[0] : '') || '',
                category: d.categoryName || '',
                unit: d.unit || 'kg',
                opening: remaining === null ? null : round3(remaining - m.all),
                bought: round3(m.purchase),
                sold: round3(-(m.sale + m.back)),
                wasted: round3(-m.wastage),
                remaining,
                purchasePrice: d.purchasePrice ?? null,
                price: d.price,
                previousPrice: d.previousPrice ?? null,
                selling: d.isAvailable !== false,
                seasonalUntil: d.seasonalUntil || null,
                sizes: d.variantsEnabled ? (d.variants || []).map((v) => ({ name: v.name, price: v.price })) : [],
            };
        }),
    };
}

/**
 * Save the morning sheet. Per row, only what was entered changes: today's price,
 * stock bought (a purchase without a bill), stock wasted, and whether it sells.
 * A new per-unit price re-prices the sizes sold by weight (500 g = half the kg price).
 */
export async function saveFreshSheet(body = {}, actor = null) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new ValidationError('Nothing to save');
    if (rows.length > 1000) throw new ValidationError('Save at most 1000 rows at a time');
    const results = [];
    const stores = new Set();
    for (const [i, row] of rows.entries()) {
        try {
            if (!isId(row?.itemId)) throw new ValidationError('Unknown product');
            const doc = await FoodItem.findById(row.itemId).select('restaurantId price unit variants variantsEnabled stockQty isAvailable section purchasePrice').lean();
            if (!doc) throw new ValidationError('Product not found');
            stores.add(String(doc.restaurantId));
            const $set = {};
            const $unset = {};

            if (row.price !== undefined && row.price !== null && row.price !== '') {
                const price = round2(row.price);
                if (!(price >= 0)) throw new ValidationError('Price must be 0 or more');
                if (price !== Number(doc.price)) {
                    $set.previousPrice = doc.price;
                    $set.price = price;
                    if (doc.variantsEnabled && Array.isArray(doc.variants) && doc.variants.length) {
                        $set.variants = doc.variants.map((v) => {
                            const share = tracked(v.stockQty) ? null : parseUnitsInName(v.name, doc.unit) || (Number(v.stockPerUnit) || null);
                            return share ? { ...v, price: Math.round(price * share) } : v;
                        });
                    }
                }
            }
            if (row.selling === false) {
                $set.isAvailable = false;
                $set.stockOffMode = 'manual';
            } else if (row.selling === true && doc.isAvailable === false) {
                $set.isAvailable = true;
                $unset.stockOffMode = '';
            }
            if (Object.keys($set).length || Object.keys($unset).length) {
                await FoodItem.updateOne({ _id: doc._id }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) });
            }

            const bought = round3(row.bought);
            if (bought > 0) {
                const rate = row.boughtRate !== undefined && row.boughtRate !== '' ? round2(row.boughtRate) : null;
                await adjustStock({
                    itemId: String(doc._id), mode: 'add', value: bought, reason: 'purchase',
                    note: 'Daily sheet', unitCost: rate ?? doc.purchasePrice ?? null, actor: actorOf(actor),
                });
                if (rate !== null) await FoodItem.updateOne({ _id: doc._id }, { $set: { purchasePrice: rate } });
            }
            const wasted = round3(row.wasted);
            if (wasted > 0) {
                await recordWastage({ itemId: String(doc._id), qty: wasted, reason: row.wasteReason || 'spoiled', note: 'Daily sheet' }, actor);
            }
            results.push({ row: i + 1, ok: true });
        } catch (err) {
            results.push({ row: i + 1, ok: false, error: err.message });
        }
    }
    for (const s of stores) invalidateStockCaches(s);
    return { saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/* ------------------------------------------------------------------ */
/* Prices: several at once, and copying a product                      */
/* ------------------------------------------------------------------ */

/**
 * Change the selling or purchase price of many sizes at once: up or down by a
 * percentage, by an amount, or set. A selling price above the MRP is refused
 * for that row only. Rounded to whole rupees for selling prices.
 */
export async function bulkUpdatePrices(body = {}) {
    const field = body.field === 'purchasePrice' ? 'purchasePrice' : 'price';
    const mode = ['pct_up', 'pct_down', 'add', 'sub', 'set'].includes(body.mode) ? body.mode : null;
    if (!mode) throw new ValidationError('Choose how to change the price');
    const value = Number(body.value);
    if (!Number.isFinite(value) || value < 0) throw new ValidationError('Enter a number of 0 or more');
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw new ValidationError('Select at least one product');
    if (rows.length > 2000) throw new ValidationError('Change at most 2000 prices at a time');

    const next = (current) => {
        const c = Number(current) || 0;
        const out = mode === 'pct_up' ? c * (1 + value / 100)
            : mode === 'pct_down' ? c * (1 - value / 100)
                : mode === 'add' ? c + value
                    : mode === 'sub' ? c - value
                        : value;
        return field === 'price' ? Math.max(0, Math.round(out)) : Math.max(0, round2(out));
    };
    const results = [];
    const stores = new Set();
    for (const [i, row] of rows.entries()) {
        try {
            if (!isId(row?.itemId)) throw new ValidationError('Unknown product');
            const doc = await FoodItem.findById(row.itemId).select('restaurantId price purchasePrice mrp variants').lean();
            if (!doc) throw new ValidationError('Product not found');
            stores.add(String(doc.restaurantId));
            const variantId = row.variantId ? String(row.variantId) : '';
            const variant = variantId ? (doc.variants || []).find((v) => String(v._id) === variantId) : null;
            if (variantId && !variant) throw new ValidationError('That size no longer exists');
            const current = variant ? variant[field] : doc[field];
            const updated = next(current);
            if (field === 'price' && doc.mrp != null && updated > Number(doc.mrp)) {
                throw new ValidationError(`₹${updated} would be above the MRP of ₹${doc.mrp}`);
            }
            if (variant) {
                await FoodItem.updateOne({ _id: doc._id, 'variants._id': variant._id }, { $set: { [`variants.$.${field}`]: updated } });
            } else {
                await FoodItem.updateOne({ _id: doc._id }, { $set: { [field]: updated, ...(field === 'price' ? { previousPrice: doc.price } : {}) } });
            }
            results.push({ row: i + 1, ok: true, from: current ?? null, to: updated });
        } catch (err) {
            results.push({ row: i + 1, ok: false, error: err.message });
        }
    }
    for (const s of stores) invalidateStockCaches(s);
    return { updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/** A copy of a product for the next similar one: same details, no stock, not yet on sale. */
export async function duplicateProduct(itemId) {
    if (!isId(itemId)) throw new ValidationError('Unknown product');
    const doc = await FoodItem.findById(itemId).lean();
    if (!doc) throw new ApiError(404, 'Product not found');
    const {
        _id, createdAt, updatedAt, __v, rating, totalRatings, stockResumeAt, ...rest
    } = doc;
    const copy = await FoodItem.create({
        ...rest,
        name: `${doc.name} (copy)`,
        sku: '',
        barcode: '',
        stockQty: null,
        isAvailable: false,
        stockOffMode: 'manual',
        isRecommended: false,
        variants: (doc.variants || []).map(({ _id: _vid, stockQty, sku, ...v }) => ({ ...v, stockQty: null, sku: '' })),
    });
    return { id: String(copy._id), name: copy.name };
}

/* ------------------------------------------------------------------ */
/* Dashboard and reports                                               */
/* ------------------------------------------------------------------ */

/**
 * What was bought in a section since `from`, per India day: the bill lines of
 * that section (GST included, as billed), plus stock added on the daily sheet
 * without a bill, at its cost.
 */
async function purchasesByDay({ store, section, from }) {
    const sec = sectionOf(section);
    const lines = await InventoryPurchase.aggregate([
        { $match: { billDate: { $gte: from }, ...(store ? { restaurantId: store } : {}) } },
        { $unwind: '$lines' },
        // Lines saved before lines carried a section take the bill's.
        { $match: { $expr: { $eq: [{ $ifNull: ['$lines.section', '$section'] }, sec] } } },
        { $project: { billDate: 1, total: '$lines.total' } },
    ]);
    const ids = await itemIdsOf({ restaurantId: store, section: sec });
    const sheet = await QCStockMovement.find({ itemId: { $in: ids }, reason: 'purchase', purchaseId: null, createdAt: { $gte: from } })
        .select('delta unitCost createdAt').lean();
    const byDay = new Map();
    const add = (date, amount) => {
        const key = istDayKey(date);
        byDay.set(key, round2((byDay.get(key) || 0) + amount));
    };
    for (const l of lines) add(l.billDate, Number(l.total) || 0);
    for (const m of sheet) add(m.createdAt, (Number(m.delta) || 0) * (Number(m.unitCost) || 0));
    return { byDay, entries: lines.length + sheet.length };
}

const moneyOfMoves = (rows) => {
    // Sales net of cancels and returns, at the selling price; wastage at cost.
    let sales = 0;
    let wastage = 0;
    for (const r of rows) {
        const qty = Number(r.delta) || 0;
        if (r.reason === 'sale' || r.reason === 'cancel' || r.reason === 'return') sales += -qty * (Number(r.unitPrice) || 0);
        else if (r.reason === 'wastage') wastage += -qty * (Number(r.unitCost) || 0);
    }
    return { sales: round2(sales), wastage: round2(wastage) };
};

async function stockValue({ restaurantId, section }) {
    const filter = { ...sectionFilter(section) };
    if (restaurantId) filter.restaurantId = oid(restaurantId);
    const docs = await FoodItem.find(filter).select('categoryName price purchasePrice stockQty variants').lean();
    const byCat = new Map();
    for (const d of docs) {
        const cat = d.categoryName || 'Uncategorised';
        const c = byCat.get(cat) || { category: cat, units: 0, cost: 0, sell: 0 };
        const add = (qty, cost, sell) => {
            if (!tracked(qty)) return;
            c.units += Number(qty) || 0;
            c.cost += (Number(qty) || 0) * (Number(cost) || 0);
            c.sell += (Number(qty) || 0) * (Number(sell) || 0);
        };
        add(d.stockQty, d.purchasePrice, d.price);
        for (const v of d.variants || []) add(v.stockQty, v.purchasePrice ?? null, v.price);
        byCat.set(cat, c);
    }
    const rows = [...byCat.values()]
        .map((c) => ({ ...c, units: round3(c.units), cost: round2(c.cost), sell: round2(c.sell) }))
        .filter((c) => c.units > 0)
        .sort((a, b) => b.cost - a.cost);
    return {
        rows,
        total: rows.reduce((t, c) => ({ units: round3(t.units + c.units), cost: round2(t.cost + c.cost), sell: round2(t.sell + c.sell) }), { units: 0, cost: 0, sell: 0 }),
    };
}

export async function inventorySummary({ restaurantId, section } = {}) {
    const store = await storeIdsOrThrow(restaurantId);
    const sec = sectionOf(section);
    const today = istDayStart(0);
    const ids = await itemIdsOf({ restaurantId: store, section: sec });
    const [stock, purchases, moves, value, recent] = await Promise.all([
        listStock({ restaurantId: store ? String(store) : undefined, section: sec, status: 'attention', limit: 8 }),
        purchasesByDay({ store, section: sec, from: today }),
        QCStockMovement.find({ itemId: { $in: ids }, createdAt: { $gte: today } }).select('reason delta unitCost unitPrice').lean(),
        stockValue({ restaurantId: store, section: sec }),
        QCStockMovement.find({ itemId: { $in: ids } }).sort({ createdAt: -1 }).limit(8)
            .select('itemName variantName delta reason wasteReason note createdAt').lean(),
    ]);
    const money = moneyOfMoves(moves);
    return {
        section: sec,
        products: ids.length,
        sizes: stock.summary.rows,
        low: stock.summary.low,
        out: stock.summary.out,
        purchasesToday: round2([...purchases.byDay.values()].reduce((t, v) => t + v, 0)),
        purchaseEntriesToday: purchases.entries,
        salesToday: money.sales,
        wastageToday: money.wastage,
        stockValue: value.total.cost,
        attention: stock.rows,
        recentMoves: recent.map((m) => ({
            name: [m.itemName, m.variantName].filter(Boolean).join(' '),
            delta: m.delta,
            reason: m.reason,
            detail: m.reason === 'wastage' ? `Wastage: ${m.wasteReason || 'other'}` : (m.note || ''),
            at: m.createdAt,
        })),
    };
}

export async function inventoryReport({ restaurantId, section, days = 7 } = {}) {
    const store = await storeIdsOrThrow(restaurantId);
    const sec = sectionOf(section);
    const span = Math.min(92, Math.max(1, Number.parseInt(days, 10) || 7));
    const from = istDayStart(span - 1);
    const ids = await itemIdsOf({ restaurantId: store, section: sec });
    const [moves, purchases, value, waste] = await Promise.all([
        QCStockMovement.find({ itemId: { $in: ids }, createdAt: { $gte: from } }).select('reason delta unitCost unitPrice createdAt').lean(),
        purchasesByDay({ store, section: sec, from }),
        stockValue({ restaurantId: store, section: sec }),
        QCStockMovement.find({ itemId: { $in: ids }, reason: 'wastage', createdAt: { $gte: from } })
            .sort({ createdAt: -1 }).limit(50).select('itemName variantName delta unitCost wasteReason note createdAt').lean(),
    ]);
    const daysOut = [];
    for (let i = span - 1; i >= 0; i -= 1) {
        const key = istDayKey(istDayStart(i));
        daysOut.push({ day: key, sales: 0, purchases: 0, wastage: 0 });
    }
    const byDay = new Map(daysOut.map((d) => [d.day, d]));
    for (const m of moves) {
        const d = byDay.get(istDayKey(m.createdAt));
        if (!d) continue;
        const money = moneyOfMoves([m]);
        d.sales = round2(d.sales + money.sales);
        d.wastage = round2(d.wastage + money.wastage);
    }
    for (const [key, amount] of purchases.byDay) {
        const d = byDay.get(key);
        if (d) d.purchases = round2(d.purchases + amount);
    }
    return {
        section: sec,
        days: daysOut,
        totals: daysOut.reduce((t, d) => ({
            sales: round2(t.sales + d.sales), purchases: round2(t.purchases + d.purchases), wastage: round2(t.wastage + d.wastage),
        }), { sales: 0, purchases: 0, wastage: 0 }),
        valuation: value,
        wastage: waste.map((w) => ({
            name: [w.itemName, w.variantName].filter(Boolean).join(' '),
            qty: round3(-w.delta),
            reason: w.wasteReason || 'other',
            note: w.note || '',
            loss: round2(-w.delta * (Number(w.unitCost) || 0)),
            at: w.createdAt,
        })),
    };
}
