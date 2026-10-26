/**
 * Trending Now: dishes an admin picked by hand in Admin > Food List.
 *
 * Separate from `isRecommended`, which each restaurant sets for its own menu's
 * "Recommended" section (and which the bulk-upload sample switches on); Trending
 * Now is the platform's shelf, so only an admin puts dishes on it.
 *
 * Dishes are serialised by the restaurant-menu builder, the same payload the app
 * already reads for a restaurant's menu, so prices, variants, stock and serving
 * hours come out exactly as they do there.
 */
import mongoose from 'mongoose';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { buildMenuFromFoods } from './restaurantMenu.service.js';
import { invalidateCache } from '../../../../middleware/cache.js';

const MAX_TRENDING = 60;

export async function listTrendingFoods(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || MAX_TRENDING, 1), MAX_TRENDING);
    const zoneIdRaw = String(query.zoneId || '').trim();

    const restaurantFilter = { status: 'approved' };
    if (zoneIdRaw && mongoose.Types.ObjectId.isValid(zoneIdRaw)) {
        restaurantFilter.zoneId = new mongoose.Types.ObjectId(zoneIdRaw);
    }
    const restaurants = await FoodRestaurant.find(restaurantFilter).select('_id restaurantName').lean();
    if (!restaurants.length) return { foods: [], total: 0 };
    const nameById = new Map(restaurants.map((r) => [String(r._id), r.restaurantName || '']));

    // Newest pick first. Out-of-stock dishes still come through (the app greys
    // them out), as on every other dish list.
    const picked = await FoodItem.find({
        restaurantId: { $in: restaurants.map((r) => r._id) },
        isTrending: true,
        approvalStatus: 'approved',
        isActive: { $ne: false },
    })
        .sort({ trendingAt: -1, _id: -1 })
        .limit(limit)
        .lean();
    if (!picked.length) return { foods: [], total: 0 };

    const menu = await buildMenuFromFoods(picked, { forCustomer: true });
    const serialised = new Map(
        (menu?.sections || []).flatMap((section) => section.items || []).map((item) => [String(item.id), item])
    );
    const foods = picked
        .map((food) => {
            const item = serialised.get(String(food._id));
            if (!item) return null;
            const restaurantId = String(food.restaurantId);
            return { ...item, restaurantId, restaurantName: nameById.get(restaurantId) || '', isTrending: true };
        })
        .filter(Boolean);
    return { foods, total: foods.length };
}

/** Admin: put a dish on Trending Now, or take it off. */
export async function setFoodTrending(foodId, isTrending) {
    if (!mongoose.Types.ObjectId.isValid(String(foodId || ''))) {
        const e = new Error('Invalid food id');
        e.statusCode = 400;
        throw e;
    }
    const on = isTrending === true || isTrending === 'true';
    const food = await FoodItem.findByIdAndUpdate(
        foodId,
        { $set: { isTrending: on, trendingAt: on ? new Date() : null } },
        { new: true, projection: { _id: 1, name: 1, isTrending: 1, trendingAt: 1 } }
    ).lean();
    if (!food) {
        const e = new Error('Food not found');
        e.statusCode = 404;
        throw e;
    }
    await invalidateCache('public_trending_foods:*').catch(() => {});
    return food;
}

/** Admin list: stamp each dish with whether it is on Trending Now (one query). */
export async function withTrendingFlags(foods = []) {
    const ids = foods.map((f) => f?._id || f?.id).filter((id) => mongoose.Types.ObjectId.isValid(String(id || '')));
    if (!ids.length) return foods;
    const on = new Set(
        (await FoodItem.find({ _id: { $in: ids }, isTrending: true }).select('_id').lean()).map((f) => String(f._id))
    );
    return foods.map((f) => ({ ...f, isTrending: on.has(String(f?._id || f?.id)) }));
}
