import { FoodItem } from '../../admin/models/food.model.js';

/**
 * Re-enable dishes whose scheduled out-of-stock window has expired.
 *
 * A dish switched off with a resume time (a time today, the next opening, or a
 * custom date) comes back on its own the moment that time passes; a dish
 * switched off manually (no stockResumeAt) is left alone until the restaurant
 * turns it back on. Called lazily from the menu reads, so no cron is needed.
 */
export async function restoreExpiredFoodAvailability(filter = {}) {
    const now = new Date();
    const result = await FoodItem.updateMany(
        {
            ...filter,
            isAvailable: false,
            stockResumeAt: { $ne: null, $lte: now },
            // A timer must not undo a count: a tracked item that actually ran
            // out stays off even if its window elapsed, so it never comes back
            // listed as available with nothing on the shelf. Untracked items
            // (stockQty null) resume exactly as they did before.
            $or: [{ stockQty: null }, { stockQty: { $gt: 0 } }]
        },
        {
            $set: { isAvailable: true, isActive: true },
            $unset: { stockResumeAt: 1, stockOffMode: 1 }
        }
    );

    return result.modifiedCount || 0;
}
