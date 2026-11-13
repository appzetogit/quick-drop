import { FoodRestaurant } from '../models/restaurant.model.js';
import { describeOutletHours } from '../../shared/outletHours.js';
import { invalidateCache } from '../../../../middleware/cache.js';

/**
 * Bring outlets that opted into auto-reopen back online once they are within
 * their opening hours again.
 *
 * An outlet gets `autoReopenAtOpening: true` only when its owner took it
 * offline during opening hours and chose "reopen automatically at opening
 * time" (restaurant app). This sweep — run every few minutes by the
 * maintenance worker — flips such outlets back to `isAcceptingOrders: true`
 * the moment the clock re-enters their window, and clears the flag.
 *
 * Open/closed is decided by the same {@link describeOutletHours} the customer
 * app uses, so per-day outlet timings, overnight windows and closed days are
 * all honoured exactly as elsewhere. An outlet whose owner brings it online
 * manually first simply stops matching (the flag is cleared on that write), so
 * this never fights a manual action.
 */
export const reopenRestaurantsAtOpeningTime = async (when = new Date()) => {
    const candidates = await FoodRestaurant.find({
        autoReopenAtOpening: true,
        isAcceptingOrders: false,
    })
        .select('_id openingTime closingTime openDays')
        .lean();

    if (!candidates.length) return { reopened: 0, checked: 0 };

    // Per-day rows win over the flat opening/closing fields where they exist,
    // matching how the public listing resolves hours.
    const { FoodRestaurantOutletTimings } = await import('../models/outletTimings.model.js');
    const ids = candidates.map((r) => r._id);
    const timingDocs = await FoodRestaurantOutletTimings.find({ restaurantId: { $in: ids } })
        .select('restaurantId timings')
        .lean();
    const byRestaurant = new Map(timingDocs.map((d) => [String(d.restaurantId), d]));

    const toReopen = [];
    for (const restaurant of candidates) {
        const hours = describeOutletHours({
            timingsDoc: byRestaurant.get(String(restaurant._id)) || null,
            restaurant,
            when,
        });
        if (hours.isOpen) toReopen.push(restaurant._id);
    }

    if (!toReopen.length) return { reopened: 0, checked: candidates.length };

    await FoodRestaurant.updateMany(
        { _id: { $in: toReopen } },
        { $set: { isAcceptingOrders: true, autoReopenAtOpening: false } },
    );

    // Same invalidation the availability route does, so the customer app sees
    // the outlet as online without waiting out the cache TTL.
    await invalidateCache('restaurants:*');
    await invalidateCache('restaurant_detail:*');

    return { reopened: toReopen.length, checked: candidates.length };
};
