import mongoose from 'mongoose';
import { FoodItem } from '../admin/models/food.model.js';
import { FoodCategory } from '../admin/models/category.model.js';
import { FoodRestaurant } from '../restaurant/models/restaurant.model.js';
import { createFood } from '../admin/services/admin.service.js';
import { adjustStock } from '../admin/services/stock.service.js';
import { invalidateStockCaches } from '../orders/services/inventory.service.js';
import { ValidationError } from '../../../core/auth/errors.js';

/**
 * Products from a spreadsheet (Admin > Quick Commerce > Inventory > Import),
 * and the one-product Quick add, which is the same thing with one row.
 *
 * Each row is matched in the chosen store by SKU, then by product name (and
 * size, for a product sold by sizes). A match is updated with only the cells
 * the sheet filled; anything else is created. Rows of a new product that name
 * sizes become one product with those sizes.
 *
 * MRP is one per product in the catalogue; for a product sold by sizes, each
 * size's MRP goes on that size as its struck-through price instead.
 *
 * The first call is a dry run that reports, per row, what would happen; the
 * admin then confirms and the same rows are applied. A bad row never stops the
 * others.
 */

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const lower = (v) => String(v ?? '').trim().toLowerCase();
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const UNITS = { kg: 'kg', kgs: 'kg', kilo: 'kg', g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', l: 'L', ltr: 'L', litre: 'L', liter: 'L', ml: 'ml', dozen: 'dozen', pc: '', pcs: '', piece: '', pieces: '', pack: '', packs: '' };
const yes = (v) => ['yes', 'y', 'true', '1', 'included', 'incl', 'inclusive'].includes(lower(v));
export const MAX_IMPORT_ROWS = 2000;

/** A number cell: undefined when blank, an error when not a number. */
function numCell(value, label, { max = Infinity } = {}) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    const n = Number(String(value).replace(/[₹,\s%]/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > max) throw new ValidationError(`${label} is not a valid number`);
    return n;
}

/** One sheet row, cleaned. Throws with a message the admin can act on. */
function cleanRow(raw = {}) {
    const name = text(raw.name, 160);
    if (!name) throw new ValidationError('Product name is empty');
    const gstRate = numCell(raw.gstRate, 'GST %', { max: 100 });
    let purchaseGstRate = numCell(raw.purchaseGstRate, 'Purchase GST %', { max: 100 });
    let purchasePrice = numCell(raw.purchasePrice, 'Purchase price');
    // A vendor price that already has GST in it is stored before GST.
    if (purchasePrice !== undefined && yes(raw.purchaseIncludesGst)) {
        const g = purchaseGstRate ?? gstRate ?? 0;
        purchasePrice = round2(purchasePrice / (1 + g / 100));
        if (purchaseGstRate === undefined) purchaseGstRate = g;
    }
    const price = numCell(raw.price, 'Selling price');
    const mrp = numCell(raw.mrp, 'MRP');
    if (price !== undefined && price <= 0) throw new ValidationError('Selling price must be more than 0');
    if (price !== undefined && mrp !== undefined && price > mrp) throw new ValidationError(`Selling price ₹${price} is above the MRP ₹${mrp}`);
    const stock = numCell(raw.stock, 'Stock');
    const unitKey = lower(raw.unit);
    if (unitKey && !(unitKey in UNITS)) throw new ValidationError(`Unit "${raw.unit}" is not one of kg, g, L, ml, dozen, pcs`);
    const sectionKey = lower(raw.section);
    const section = !sectionKey ? undefined
        : /fresh|fruit|veg(etable)?s?$|f&v|fnv/.test(sectionKey) && !/non/.test(sectionKey) ? 'fresh'
            : 'grocery';
    const type = lower(raw.foodType);
    return {
        name,
        size: text(raw.size, 60),
        category: text(raw.category, 120),
        section,
        unit: unitKey ? UNITS[unitKey] : undefined,
        brand: raw.brand === undefined ? undefined : text(raw.brand, 120) || undefined,
        packSize: raw.packSize === undefined ? undefined : text(raw.packSize, 60) || undefined,
        sku: text(raw.sku, 80),
        barcode: text(raw.barcode, 80),
        description: raw.description === undefined ? undefined : text(raw.description, 2000) || undefined,
        foodType: type.startsWith('non') ? 'Non-Veg' : 'Veg',
        price: price === undefined ? undefined : Math.round(price * 100) / 100,
        mrp,
        gstRate,
        purchasePrice: purchasePrice === undefined ? undefined : round2(purchasePrice),
        purchaseGstRate,
        stock: stock === undefined ? undefined : round3(stock),
        lowStockAt: numCell(raw.lowStockAt, 'Low stock alert'),
    };
}

/** Categories a product in this store may use, by name (the store's own first). */
async function categoriesFor(storeId) {
    const docs = await FoodCategory.find({
        isActive: { $ne: false },
        approvalStatus: { $ne: 'rejected' },
        $or: [{ restaurantId: storeId }, { restaurantId: { $exists: false } }, { restaurantId: null }],
    }).select('name restaurantId').lean();
    const map = new Map();
    for (const c of docs) {
        const key = lower(c.name);
        const prev = map.get(key);
        if (!prev || (c.restaurantId && !prev.restaurantId)) map.set(key, c);
    }
    return map;
}

const fmt = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

/** What updating a matched product with this row changes, as $set paths and readable notes. */
function updatePlan(doc, variant, row) {
    const $set = {};
    const changes = [];
    const at = variant ? 'variants.$.' : '';
    const cur = (k) => (variant ? variant[k] : doc[k]);
    const put = (path, value, label, show = value) => {
        $set[path] = value;
        changes.push(`${label} ${show}`);
    };
    const sizeMrp = variant && Number(variant.otherPrice) > 0 ? Number(variant.otherPrice) : null;
    if (row.price !== undefined && Number(cur('price')) !== row.price) {
        const mrp = row.mrp ?? (variant ? sizeMrp : doc.mrp);
        if (mrp != null && row.price > Number(mrp)) throw new ValidationError(`Selling price ₹${row.price} is above the MRP ₹${mrp}`);
        put(`${at}price`, row.price, 'price', `${fmt(cur('price'))} → ${fmt(row.price)}`);
        if (!variant) $set.previousPrice = doc.price;
    }
    if (row.purchasePrice !== undefined && Number(cur('purchasePrice')) !== row.purchasePrice) {
        put(`${at}purchasePrice`, row.purchasePrice, 'purchase price', fmt(row.purchasePrice));
    }
    if (row.gstRate !== undefined && Number(cur('gstRate')) !== row.gstRate) put(`${at}gstRate`, row.gstRate, 'GST', `${row.gstRate}%`);
    if (row.lowStockAt !== undefined) $set[`${at}lowStockThreshold`] = Math.floor(row.lowStockAt);
    if (row.sku && variant && variant.sku !== row.sku) put('variants.$.sku', row.sku, 'SKU');
    if (row.sku && !variant && doc.sku !== row.sku) put('sku', row.sku, 'SKU');
    // Product-wide cells.
    if (row.mrp !== undefined && variant && sizeMrp !== row.mrp) {
        if (row.price === undefined && Number(variant.price) > row.mrp) throw new ValidationError(`MRP ₹${row.mrp} is below the selling price ₹${variant.price}`);
        put('variants.$.otherPrice', row.mrp, 'MRP', fmt(row.mrp));
    }
    if (row.mrp !== undefined && !variant && Number(doc.mrp) !== row.mrp) {
        if (row.price === undefined && Number(doc.price) > row.mrp) throw new ValidationError(`MRP ₹${row.mrp} is below the selling price ₹${doc.price}`);
        put('mrp', row.mrp, 'MRP', fmt(row.mrp));
    }
    if (row.purchaseGstRate !== undefined && Number(doc.purchaseGstRate) !== row.purchaseGstRate) put('purchaseGstRate', row.purchaseGstRate, 'purchase GST', `${row.purchaseGstRate}%`);
    if (row.section && (doc.section || 'grocery') !== row.section) put('section', row.section, 'section', row.section === 'fresh' ? 'Fruits & Veg' : 'Grocery');
    if (row.unit !== undefined && (doc.unit || '') !== row.unit) put('unit', row.unit, 'unit', row.unit || 'pieces');
    if (row.brand !== undefined && doc.brand !== row.brand) put('brand', row.brand, 'brand');
    if (row.packSize !== undefined && doc.packSize !== row.packSize) put('packSize', row.packSize, 'pack size');
    if (row.barcode && doc.barcode !== row.barcode) put('barcode', row.barcode, 'barcode');
    if (row.description !== undefined && doc.description !== row.description) put('description', row.description, 'description', '');
    const currentStock = cur('stockQty');
    if (row.stock !== undefined && Number(currentStock) !== row.stock) {
        changes.push(`stock ${currentStock ?? 'untracked'} → ${row.stock}`);
    }
    return { $set, changes };
}

/**
 * body: { restaurantId, rows: [...], dryRun = true }
 * Returns { dryRun, summary: { create, update, same, error }, rows: [{ row, name, size, action, changes, error }] }
 */
export async function importProducts(body = {}, actor = null) {
    if (!isId(body.restaurantId)) throw new ValidationError('Pick the store these products are for');
    const storeId = new mongoose.Types.ObjectId(String(body.restaurantId));
    const store = await FoodRestaurant.findById(storeId).select('restaurantName pureVegRestaurant').lean();
    if (!store) throw new ValidationError('Store not found');
    const input = Array.isArray(body.rows) ? body.rows : [];
    if (!input.length) throw new ValidationError('The sheet has no product rows');
    if (input.length > MAX_IMPORT_ROWS) throw new ValidationError(`Import at most ${MAX_IMPORT_ROWS} rows at a time`);
    const dryRun = body.dryRun !== false;

    const existing = await FoodItem.find({ restaurantId: storeId })
        .select('name sku skuCode barcode variants mrp price purchasePrice purchaseGstRate gstRate section unit brand packSize description stockQty lowStockThreshold')
        .lean();
    const bySku = new Map();
    const byName = new Map();
    for (const doc of existing) {
        if (!byName.has(lower(doc.name))) byName.set(lower(doc.name), doc);
        for (const s of [doc.sku, doc.skuCode]) if (s) bySku.set(lower(s), { doc, variant: null });
        for (const v of doc.variants || []) if (v.sku) bySku.set(lower(v.sku), { doc, variant: v });
    }
    const categories = await categoriesFor(storeId);

    const out = [];
    const creates = new Map(); // product name -> { rows: [{ i, row }], category }
    const updates = [];
    for (const [i, raw] of input.entries()) {
        const result = { row: i + 1, name: text(raw?.name, 160), size: text(raw?.size, 60), action: 'error', changes: [], error: '' };
        out.push(result);
        try {
            const row = cleanRow(raw);
            const hit = row.sku ? bySku.get(lower(row.sku)) : null;
            let doc = hit?.doc || byName.get(lower(row.name)) || null;
            let variant = hit?.variant || null;
            if (doc && !variant && (doc.variants || []).length) {
                if (!row.size) throw new ValidationError(`${doc.name} is sold by sizes (${doc.variants.map((v) => v.name).join(', ')}); fill the Size column`);
                variant = doc.variants.find((v) => lower(v.name) === lower(row.size)) || null;
                if (!variant) throw new ValidationError(`${doc.name} has no size "${row.size}". Add the size in the product form first`);
            } else if (doc && !variant && row.size && lower(row.size) !== lower(doc.packSize)) {
                throw new ValidationError(`${doc.name} is already a single product with no sizes; leave Size empty or use Pack size`);
            }
            if (doc) {
                if (row.category) {
                    const cat = categories.get(lower(row.category));
                    if (!cat) throw new ValidationError(`Category "${row.category}" not found`);
                }
                const plan = updatePlan(doc, variant, row);
                result.name = doc.name;
                result.size = variant?.name || '';
                result.action = plan.changes.length || Object.keys(plan.$set).length ? 'update' : 'same';
                result.changes = plan.changes;
                if (result.action === 'update') updates.push({ result, doc, variant, row, plan });
                continue;
            }
            if (!row.category) throw new ValidationError('New product: fill the Category');
            const cat = categories.get(lower(row.category));
            if (!cat) throw new ValidationError(`Category "${row.category}" not found. Create it first or use an existing name`);
            if (row.price === undefined) throw new ValidationError('New product: fill the Selling price');
            if (store.pureVegRestaurant && row.foodType !== 'Veg') throw new ValidationError('This store sells veg only');
            const key = lower(row.name);
            const group = creates.get(key) || { rows: [], category: cat };
            if (group.rows.length && Boolean(group.rows[0].row.size) !== Boolean(row.size)) {
                throw new ValidationError(`${row.name} appears more than once: give every row a Size, or keep one row`);
            }
            if (group.rows.some((r) => lower(r.row.size) === lower(row.size))) throw new ValidationError(`${row.name}${row.size ? ` ${row.size}` : ''} is listed twice`);
            group.rows.push({ row, result });
            creates.set(key, group);
            result.action = 'create';
            result.changes = [
                `${fmt(row.price)}${row.mrp ? ` (MRP ${fmt(row.mrp)})` : ''}`,
                cat.name,
                row.section === 'fresh' ? 'Fruits & Veg' : 'Grocery',
                ...(row.stock !== undefined ? [`stock ${row.stock}${row.unit ? ` ${row.unit}` : ''}`] : []),
            ];
        } catch (err) {
            result.action = 'error';
            result.error = err.message;
        }
    }

    const summary = () => out.reduce((s, r) => ({ ...s, [r.action]: (s[r.action] || 0) + 1 }), { create: 0, update: 0, same: 0, error: 0 });
    if (dryRun) return { dryRun: true, summary: summary(), rows: out };

    const a = actor || { role: 'admin', id: '', name: 'Admin' };
    const note = 'Excel import';
    for (const u of updates) {
        try {
            if (Object.keys(u.plan.$set).length) {
                const match = u.variant ? { _id: u.doc._id, 'variants._id': u.variant._id } : { _id: u.doc._id };
                await FoodItem.updateOne(match, { $set: u.plan.$set });
            }
            if (u.row.stock !== undefined && Number(u.variant ? u.variant.stockQty : u.doc.stockQty) !== u.row.stock) {
                await adjustStock({ itemId: String(u.doc._id), variantId: u.variant ? String(u.variant._id) : '', mode: 'set', value: u.row.stock, reason: 'import', note, unitCost: u.row.purchasePrice, actor: a });
            }
        } catch (err) {
            u.result.action = 'error';
            u.result.error = err.message;
        }
    }
    for (const group of creates.values()) {
        const first = group.rows[0].row;
        const sized = Boolean(first.size);
        try {
            const pick = (k) => group.rows.map((r) => r.row[k]).find((v) => v !== undefined);
            const created = await createFood({
                restaurantId: String(storeId),
                name: first.name,
                categoryId: String(group.category._id),
                categoryName: group.category.name,
                foodType: first.foodType,
                description: pick('description') || '',
                ...(sized
                    ? {
                        variants: group.rows.map(({ row }) => ({
                            name: row.size,
                            price: row.price,
                            ...(row.mrp !== undefined ? { otherPrice: row.mrp } : {}),
                            ...(row.sku ? { sku: row.sku } : {}),
                            ...(row.gstRate !== undefined ? { gstRate: row.gstRate } : {}),
                            ...(row.purchasePrice !== undefined ? { purchasePrice: row.purchasePrice } : {}),
                            ...(row.lowStockAt !== undefined ? { lowStockThreshold: row.lowStockAt } : {}),
                        })),
                    }
                    : { price: first.price, ...(first.lowStockAt !== undefined ? { lowStockThreshold: first.lowStockAt } : {}) }),
                mrp: sized ? undefined : first.mrp,
                gstRate: pick('gstRate'),
                brand: pick('brand'),
                packSize: pick('packSize'),
                section: pick('section') || 'grocery',
                unit: pick('unit') || (pick('section') === 'fresh' ? 'kg' : ''),
                purchasePrice: sized ? undefined : first.purchasePrice,
                purchaseGstRate: pick('purchaseGstRate'),
                isAvailable: true,
            });
            const extra = {};
            if (!sized && first.sku) extra.sku = first.sku;
            if (pick('barcode')) extra.barcode = pick('barcode');
            if (Object.keys(extra).length) await FoodItem.updateOne({ _id: created._id }, { $set: extra });
            // Opening stock goes through the stock history like any other count.
            for (const { row } of group.rows) {
                if (row.stock === undefined) continue;
                const variant = sized ? (created.variants || []).find((v) => lower(v.name) === lower(row.size)) : null;
                await adjustStock({ itemId: String(created._id), variantId: variant ? String(variant._id) : '', mode: 'set', value: row.stock, reason: 'import', note, unitCost: row.purchasePrice, actor: a });
            }
            for (const { result } of group.rows) result.id = String(created._id);
        } catch (err) {
            for (const { result } of group.rows) {
                result.action = 'error';
                result.error = err.message;
            }
        }
    }
    invalidateStockCaches(storeId);
    return { dryRun: false, summary: summary(), rows: out };
}
