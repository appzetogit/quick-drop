import express from 'express';
import mongoose from 'mongoose';
import { invalidateCache } from '../../../../middleware/cache.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { listCategoriesController } from '../../restaurant/controllers/restaurantCategory.controller.js';
import { getMenuController } from '../../restaurant/controllers/restaurantMenu.controller.js';
import {
    createRestaurantFoodController,
    updateRestaurantFoodController,
} from '../../restaurant/controllers/restaurantFood.controller.js';
import {
    listAddonsController,
    createAddonController,
    updateAddonController,
    deleteAddonController,
} from '../../restaurant/controllers/restaurantAddon.controller.js';
import {
    getRestaurantCommissionRateController,
    getRestaurantTaxSettingsController,
} from '../../restaurant/controllers/restaurant.controller.js';

/**
 * The restaurant portal's menu tools, run by an admin for one restaurant:
 * /food/admin/restaurants/:restaurantId/portal/...
 *
 * Client call, 2026-11-23: the admin's item editor should look and work like
 * the restaurant's, and an admin's change should go through approval too.
 * So these run the restaurant's OWN handlers (same validation, same pending /
 * resubmit rules, same document), with the restaurant id taken from the path
 * instead of the login. Approval status is therefore the same for both sides,
 * and the change is approved on Food Approval like any other.
 *
 * Mounted inside the food admin router, after its admin login and permission
 * checks.
 */
export default function restaurantPortalRouter() {
    const router = express.Router({ mergeParams: true });

    // Act as the restaurant in the path. Only the id the handlers read changes;
    // the admin stays the authenticated user for logging and permissions.
    router.use(async (req, res, next) => {
        try {
            const { restaurantId } = req.params;
            if (!mongoose.Types.ObjectId.isValid(String(restaurantId))) {
                return res.status(400).json({ success: false, message: 'Invalid restaurant id' });
            }
            const exists = await FoodRestaurant.exists({ _id: restaurantId });
            if (!exists) return res.status(404).json({ success: false, message: 'Restaurant not found' });
            req.adminUser = req.user;
            req.user = { ...req.user, userId: String(restaurantId), actingAdminId: req.user?.userId || req.user?.id || null };
            return next();
        } catch (err) {
            return next(err);
        }
    });

    const clearMenuCaches = async (req, res, next) => {
        await invalidateCache('restaurant_menu:*');
        await invalidateCache('restaurants:*');
        next();
    };
    const clearAddonCache = async (req, res, next) => {
        await invalidateCache('restaurant_addons:*');
        next();
    };

    router.get('/menu', getMenuController);
    router.get('/categories', listCategoriesController);
    router.get('/commission', getRestaurantCommissionRateController);
    router.get('/tax-settings', getRestaurantTaxSettingsController);

    router.post('/foods', clearMenuCaches, createRestaurantFoodController);
    router.patch('/foods/:id', clearMenuCaches, updateRestaurantFoodController);

    router.get('/item-extras', listAddonsController);
    router.post('/item-extras', clearAddonCache, createAddonController);
    router.patch('/item-extras/:id', clearAddonCache, updateAddonController);
    router.delete('/item-extras/:id', clearAddonCache, deleteAddonController);

    return router;
}
