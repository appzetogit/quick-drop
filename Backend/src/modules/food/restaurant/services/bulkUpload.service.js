import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import axios from 'axios';
import { v2 as cloudinary } from 'cloudinary';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodCategory } from '../../admin/models/category.model.js';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { config } from '../../../../config/env.js';

cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret
});

const PREP_TIME_OPTIONS = [
    '5-10 mins', '10-15 mins', '15-20 mins', '20-25 mins', 
    '25-30 mins', '30-40 mins', '40-50 mins', '50+ mins'
];

/**
 * Generates an Excel template for bulk menu upload.
 */
export async function generateBulkMenuTemplate() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Menu Template');

    // Define Columns
    sheet.columns = [
        { header: 'Category*', key: 'category', width: 20 },
        { header: 'Item Name*', key: 'name', width: 30 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Base Price*', key: 'price', width: 15 },
        { header: 'Food Type (Veg/Non-Veg)*', key: 'foodType', width: 25 },
        { header: 'Recommended (Yes/No)', key: 'isRecommended', width: 25 },
        { header: 'Preparation Time*', key: 'prepTime', width: 25 },
        { header: 'Image URL', key: 'imageUrl', width: 40 },
        { header: 'Variant 1 Name', key: 'v1Name', width: 20 },
        { header: 'Variant 1 Price', key: 'v1Price', width: 15 },
        { header: 'Variant 2 Name', key: 'v2Name', width: 20 },
        { header: 'Variant 2 Price', key: 'v2Price', width: 15 },
        { header: 'Variant 3 Name', key: 'v3Name', width: 20 },
        { header: 'Variant 3 Price', key: 'v3Price', width: 15 },
    ];

    // Style headers
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    // Add Data Validations for 500 rows
    for (let i = 2; i <= 501; i++) {
        // Food Type Dropdown
        sheet.getCell(`E${i}`).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: ['"Veg,Non-Veg"']
        };

        // Recommended Dropdown
        sheet.getCell(`F${i}`).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: ['"Yes,No"']
        };

        // Preparation Time Dropdown
        sheet.getCell(`G${i}`).dataValidation = {
            type: 'list',
            allowBlank: false,
            formulae: [`"${PREP_TIME_OPTIONS.join(',')}"`]
        };

        // Numeric Validation for Prices
        const priceCells = [`D${i}`, `J${i}`, `L${i}`, `N${i}`];
        priceCells.forEach(cell => {
            sheet.getCell(cell).dataValidation = {
                type: 'decimal',
                operator: 'greaterThanOrEqual',
                showErrorMessage: true,
                allowBlank: true,
                formulae: [0],
                errorTitle: 'Invalid Price',
                error: 'Price must be a number greater than or equal to 0'
            };
        });
    }

    // Add Sample Row
    sheet.addRow({
        category: 'Starters',
        name: 'Paneer Tikka',
        description: 'Spicy marinated paneer grilled to perfection',
        price: 250,
        foodType: 'Veg',
        isRecommended: 'Yes',
        prepTime: '20-25 mins',
        imageUrl: 'https://example.com/paneer.jpg',
        v1Name: 'Half',
        v1Price: 150,
        v2Name: 'Full',
        v2Price: 280
    });

    return workbook;
}

/**
 * Processes the uploaded bulk menu Excel file.
 */
export async function processBulkMenuUpload(restaurantId, fileBuffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    const sheet = workbook.getWorksheet(1);

    const restaurant = await FoodRestaurant.findById(restaurantId).lean();
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const items = [];
    const parsingErrors = [];
    const maxItems = 500;
    let rowCount = 0;

    const getNumericValue = (cell) => {
        if (!cell || cell.value === null || cell.value === undefined) return 0;
        if (typeof cell.value === 'object' && cell.value.result !== undefined) {
            return parseFloat(cell.value.result) || 0;
        }
        return parseFloat(cell.value) || 0;
    };

    const getTextValue = (cell) => {
        if (!cell || cell.value === null || cell.value === undefined) return '';
        
        // Handle Hyperlinks (often how URLs are stored in Excel)
        if (typeof cell.value === 'object') {
            if (cell.value.hyperlink) return String(cell.value.hyperlink).trim();
            if (cell.value.text) return String(cell.value.text).trim();
        }
        
        // Handle Rich Text
        if (cell.value.richText) {
            return cell.value.richText.map(rt => rt.text).join('').trim();
        }
        
        // Handle Formula Result
        if (typeof cell.value === 'object' && cell.value.result !== undefined) {
            return String(cell.value.result).trim();
        }
        
        // Handle Shared Strings / Plain Values
        return String(cell.value).trim();
    };

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip Header
        if (rowCount >= maxItems) return;

        try {
            const data = {
                category: getTextValue(row.getCell(1)),
                name: getTextValue(row.getCell(2)),
                description: getTextValue(row.getCell(3)),
                price: getNumericValue(row.getCell(4)),
                foodType: getTextValue(row.getCell(5)),
                isRecommended: String(row.getCell(6).value || '').toLowerCase() === 'yes',
                prepTime: getTextValue(row.getCell(7)),
                imageUrl: getTextValue(row.getCell(8)),
                variants: []
            };

            // Mandatory Field Check
            if (!data.category || !data.name) {
                // Only report as error if row is not completely empty
                const hasAnyData = row.values.some(v => v !== null && v !== undefined && v !== '');
                if (hasAnyData) {
                    parsingErrors.push({ row: rowNumber, error: 'Category and Item Name are mandatory' });
                }
                return;
            }

            rowCount++;

            // Parse Variants (Columns 9 to 14)
            for (let j = 0; j < 3; j++) {
                const vName = getTextValue(row.getCell(9 + j * 2));
                const vPrice = getNumericValue(row.getCell(10 + j * 2));
                if (vName && vPrice > 0) {
                    data.variants.push({ name: vName, price: vPrice });
                }
            }

            items.push({ data, rowNumber });
        } catch (err) {
            parsingErrors.push({ row: rowNumber, error: `Parsing error: ${err.message}` });
        }
    });

    if (items.length === 0 && parsingErrors.length === 0) {
        throw new ValidationError('No valid items found in the Excel sheet');
    }

    const results = {
        success: 0,
        failed: 0,
        details: [...parsingErrors]
    };

    // --- OPTIMIZATION: Resolve All Categories First ---
    const categoryCache = new Map();
    const uniqueCategoryNames = [...new Set(items.map(it => it.data.category))];
    
    for (const catName of uniqueCategoryNames) {
        const normalized = catName.trim();
        let cat = await FoodCategory.findOne({
            name: { $regex: new RegExp(`^${escapeRegExp(normalized)}$`, 'i') },
            $or: [{ restaurantId: null }, { restaurantId: restaurant._id }]
        });

        if (!cat) {
            cat = await FoodCategory.create({
                name: normalized,
                restaurantId: restaurant._id,
                createdByRestaurantId: restaurant._id,
                approvalStatus: 'approved',
                zoneId: restaurant.zoneId,
                isActive: true
            });
        }
        categoryCache.set(normalized.toLowerCase(), cat);
    }

    // --- OPTIMIZATION: Batch process items with concurrency ---
    const CONCURRENCY = 10;
    const itemChunks = [];
    for (let i = 0; i < items.length; i += CONCURRENCY) {
        itemChunks.push(items.slice(i, i + CONCURRENCY));
    }

    const bulkOps = [];

    for (const chunk of itemChunks) {
        const chunkPromises = chunk.map(async (item) => {
            try {
                const { data, rowNumber } = item;

                // 1. Get Pre-Resolved Category
                const category = categoryCache.get(data.category.toLowerCase());
                if (!category) throw new Error(`Category ${data.category} could not be resolved`);

                // 2. Handle Image Parallel Upload
                let finalImageUrl = '';
                if (data.imageUrl) {
                    const trimmedUrl = data.imageUrl.trim();
                    // If already a Cloudinary URL, don't re-upload
                    if (trimmedUrl.includes('cloudinary.com')) {
                        finalImageUrl = trimmedUrl;
                    } else if (trimmedUrl.startsWith('http') || trimmedUrl.startsWith('//')) {
                        try {
                            const urlToUpload = trimmedUrl.startsWith('//') ? `https:${trimmedUrl}` : trimmedUrl;
                            const uploadRes = await cloudinary.uploader.upload(urlToUpload, {
                                folder: `restaurants/${restaurantId}/food`
                            });
                            finalImageUrl = uploadRes.secure_url;
                        } catch (imgErr) {
                            console.error(`Row ${rowNumber}: Image upload failed [${trimmedUrl}]:`, imgErr.message);
                        }
                    }
                }

                // 3. Prepare Bulk Operation
                bulkOps.push({
                    updateOne: {
                        filter: { name: data.name, restaurantId: restaurant._id },
                        update: {
                            $set: {
                                categoryId: category._id,
                                categoryName: category.name,
                                description: data.description,
                                price: data.variants.length > 0 ? Math.min(...data.variants.map(v => v.price)) : data.price,
                                variants: data.variants,
                                ...(finalImageUrl && { image: finalImageUrl }),
                                foodType: data.foodType === 'Veg' ? 'Veg' : 'Non-Veg',
                                isRecommended: data.isRecommended,
                                preparationTime: data.prepTime,
                                approvalStatus: 'pending',
                                requestedAt: new Date(),
                                rejectionReason: '',
                                approvedAt: null,
                                rejectedAt: null
                            }
                        },
                        upsert: true
                    }
                });

                results.success++;
            } catch (err) {
                results.failed++;
                results.details.push({ row: item.rowNumber, error: err.message });
            }
        });

        await Promise.all(chunkPromises);
    }

    // --- OPTIMIZATION: Execute Bulk Write ---
    if (bulkOps.length > 0) {
        try {
            await FoodItem.bulkWrite(bulkOps);
        } catch (bulkErr) {
            console.error('Bulk write failed:', bulkErr.message);
            results.details.push({ row: 'N/A', error: `Database saving failed: ${bulkErr.message}` });
        }
    }

    if (results.success > 0) {
        try {
            const { invalidateCache } = await import('../../../../middleware/cache.js');
            await invalidateCache(`restaurant_menu:${restaurantId}`);
        } catch (cacheErr) {
            console.error('Failed to invalidate cache after bulk upload:', cacheErr);
        }
    }

    return results;
}

/**
 * Escapes characters for use in a regular expression.
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
