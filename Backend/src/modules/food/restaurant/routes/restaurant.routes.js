import express from 'express';
import { upload } from '../../../../middleware/upload.js';
import {
    registerRestaurantController,
    listApprovedRestaurantsController,
    getApprovedRestaurantController,
    listPublicOffersController,
    getCurrentRestaurantController,
    getRestaurantCommissionRateController,
    getFreebieOfferController,
    updateFreebieOfferController,
    updateRestaurantProfileController,
    updateRestaurantAcceptingOrdersController,
    updateCurrentRestaurantDiningSettingsController,
    uploadRestaurantProfileImageController,
    uploadRestaurantMenuImageController,
    uploadRestaurantCoverImagesController,
    uploadRestaurantMenuImagesController,
    getRestaurantComplaintsController,
    uploadRestaurantAttachmentController,
    deleteCurrentRestaurantAccountController,
    getRestaurantPublicReviewsController,
} from '../controllers/restaurant.controller.js';
import {
    createRestaurantOfferController,
    listRestaurantOffersController,
    deleteRestaurantOfferController,
    updateRestaurantOfferStatusController
} from '../controllers/restaurantOffer.controller.js';
import {
    createRestaurantSupportTicketController,
    listRestaurantSupportTicketsController
} from '../controllers/supportTicket.controller.js';
import {
    createWithdrawalRequestController,
    listMyWithdrawalsController
} from '../controllers/withdrawal.controller.js';
import {
    listCategoriesController,
    createCategoryController,
    updateCategoryController,
    deleteCategoryController
} from '../controllers/restaurantCategory.controller.js';
import { getMenuController, updateMenuController, getPublicRestaurantMenuController } from '../controllers/restaurantMenu.controller.js';
import { getPublicRestaurantAddonsController } from '../controllers/publicAddons.controller.js';
import * as feedbackExperienceController from '../../admin/controllers/feedbackExperience.controller.js';
import {
    getOutletTimingsByRestaurantIdController,
    getCurrentRestaurantOutletTimingsController,
    upsertCurrentRestaurantOutletTimingsController
} from '../controllers/outletTimings.controller.js';
import {
    createRestaurantFoodController,
    updateRestaurantFoodController
} from '../controllers/restaurantFood.controller.js';
import {
    listAddonsController,
    createAddonController,
    updateAddonController,
    deleteAddonController
} from '../controllers/restaurantAddon.controller.js';
import {
    downloadBulkMenuTemplateController,
    uploadBulkMenuController
} from '../controllers/bulkUpload.controller.js';
import * as orderController from '../../orders/controllers/order.controller.js';
import { authMiddleware } from '../../../../core/auth/auth.middleware.js';
import { sendError } from '../../../../utils/response.js';
import { getRestaurantFinanceController } from '../controllers/restaurantFinance.controller.js';
import { listPublicFoodsController } from '../controllers/publicFoods.controller.js';
import {
    getMediaController,
    uploadCoverImageController,
    uploadGalleryImagesController,
    deleteGalleryImageController
} from '../controllers/restaurantMedia.controller.js';

import { cacheResponse, invalidateCache } from '../../../../middleware/cache.js';

const router = express.Router();

const requireRestaurant = (req, res, next) => {
    if (req.user?.role !== 'RESTAURANT') {
        return sendError(res, 403, 'Restaurant access required');
    }
    next();
};

const uploadFields = upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'panImage', maxCount: 1 },
    { name: 'gstImage', maxCount: 1 },
    { name: 'fssaiImage', maxCount: 1 },
    { name: 'menuImages', maxCount: 10 }
]);

router.post('/register', uploadFields, registerRestaurantController);
router.post('/upload-attachment', upload.single('file'), uploadRestaurantAttachmentController);

// Public: approved restaurants list (for user app)
router.get('/restaurants', cacheResponse(300, 'restaurants'), listApprovedRestaurantsController);
router.get('/restaurants/:id', cacheResponse(600, 'restaurant_detail'), getApprovedRestaurantController);
router.get('/restaurants/:id/menu', cacheResponse(600, 'restaurant_menu'), getPublicRestaurantMenuController);
router.get('/restaurants/:id/reviews', getRestaurantPublicReviewsController);
router.get('/restaurants/:id/outlet-timings', cacheResponse(600, 'restaurant_timings'), getOutletTimingsByRestaurantIdController);
router.get('/offers', cacheResponse(300, 'offers'), listPublicOffersController);
// Public: cross-restaurant dish feed, used by the home screen's category rails and
// the under-250 promo. Declared before the ':id' routes above cannot swallow it --
// '/public/foods' has two segments, so there is no collision either way.
router.get('/public/foods', cacheResponse(300, 'public_foods'), listPublicFoodsController);
// Public: categories list (zone-aware; returns zone categories + global)
router.get('/categories/public', cacheResponse(600, 'categories'), listCategoriesController);

// Restaurant dashboard/profile (Bearer token + RESTAURANT role)
router.get('/current', authMiddleware, requireRestaurant, getCurrentRestaurantController);
router.patch('/profile', authMiddleware, requireRestaurant, async (req, res, next) => {
    // Invalidate caches when profile is updated
    await invalidateCache('restaurants:*');
    await invalidateCache('restaurant_detail:*');
    next();
}, updateRestaurantProfileController);
router.patch('/availability', authMiddleware, requireRestaurant, async (req, res, next) => {
    await invalidateCache('restaurants:*');
    next();
}, updateRestaurantAcceptingOrdersController);
router.get('/commission', authMiddleware, requireRestaurant, getRestaurantCommissionRateController);
router.get('/freebie-offer', authMiddleware, requireRestaurant, getFreebieOfferController);
router.put('/freebie-offer', authMiddleware, requireRestaurant, updateFreebieOfferController);
router.patch('/profile', authMiddleware, requireRestaurant, updateRestaurantProfileController);
router.delete('/profile/account', authMiddleware, requireRestaurant, deleteCurrentRestaurantAccountController);
// Same handler under the name quick-commerce uses. The restaurant app serves both
// verticals off one set of paths, rewriting only the `/food` prefix to `/qc` — an
// invariant that holds for every other seller route, and broke here because the
// two forks named account deletion differently. Aliasing is cheaper and safer
// than teaching the client that one path is special.
router.delete('/current', authMiddleware, requireRestaurant, deleteCurrentRestaurantAccountController);
router.patch('/availability', authMiddleware, requireRestaurant, updateRestaurantAcceptingOrdersController);
router.patch('/dining-settings', authMiddleware, requireRestaurant, updateCurrentRestaurantDiningSettingsController);
router.get('/outlet-timings', authMiddleware, requireRestaurant, getCurrentRestaurantOutletTimingsController);
router.put('/outlet-timings', authMiddleware, requireRestaurant, upsertCurrentRestaurantOutletTimingsController);
router.get('/finance', authMiddleware, requireRestaurant, getRestaurantFinanceController);
router.post('/withdraw', authMiddleware, requireRestaurant, createWithdrawalRequestController);
router.get('/withdrawals', authMiddleware, requireRestaurant, listMyWithdrawalsController);
router.post(
    '/profile/profile-image',
    authMiddleware,
    requireRestaurant,
    upload.single('file'),
    async (req, res, next) => {
        await invalidateCache('restaurants:*');
        await invalidateCache('restaurant_detail:*');
        next();
    },
    uploadRestaurantProfileImageController
);
router.post(
    '/profile/menu-image',
    authMiddleware,
    requireRestaurant,
    upload.single('file'),
    async (req, res, next) => {
        await invalidateCache('restaurant_menu:*');
        next();
    },
    uploadRestaurantMenuImageController
);
router.post(
    '/profile/cover-images',
    authMiddleware,
    requireRestaurant,
    upload.array('files', 20),
    async (req, res, next) => {
        await invalidateCache('restaurant_detail:*');
        next();
    },
    uploadRestaurantCoverImagesController
);
router.post(
    '/profile/menu-images',
    authMiddleware,
    requireRestaurant,
    upload.array('files', 20),
    async (req, res, next) => {
        await invalidateCache('restaurant_menu:*');
        next();
    },
    uploadRestaurantMenuImagesController
);

// ----- Media: main cover image + premises gallery -----
//
// Separate from the /profile/* image routes above, which reset the restaurant's
// status to 'pending'. That is correct for a document that changes what was
// approved and wrong for swapping a photo -- it takes a live restaurant offline
// and forces re-approval. Nothing in this block touches status.
router.get('/media', authMiddleware, requireRestaurant, getMediaController);
router.post('/media/cover-image', authMiddleware, requireRestaurant, upload.single('file'), uploadCoverImageController);
router.post('/media/gallery', authMiddleware, requireRestaurant, upload.array('files', 10), uploadGalleryImagesController);
// DELETE carries the url in the body: image urls contain slashes, which no
// single path segment can hold.
router.delete('/media/gallery', authMiddleware, requireRestaurant, deleteGalleryImageController);

// Categories (restaurant dashboard). Read-only for item creation, CRUD for Menu Categories page.
router.get('/categories', authMiddleware, requireRestaurant, listCategoriesController);
router.post('/categories', authMiddleware, requireRestaurant, createCategoryController);
router.patch('/categories/:id', authMiddleware, requireRestaurant, updateCategoryController);
router.delete('/categories/:id', authMiddleware, requireRestaurant, deleteCategoryController);

// Menu (restaurant dashboard) - only fields needed by UI
router.get('/menu', authMiddleware, requireRestaurant, getMenuController);
router.patch('/menu', authMiddleware, requireRestaurant, async (req, res, next) => {
    await invalidateCache('restaurant_menu:*');
    next();
}, updateMenuController);

// Feedback (restaurant dashboard)
router.post('/feedback-experience', authMiddleware, requireRestaurant, feedbackExperienceController.createFeedbackExperience);

// Public: restaurant add-ons (user app)
router.get('/restaurants/:id/addons', cacheResponse(600, 'restaurant_addons'), getPublicRestaurantAddonsController);

// Foods (restaurant creates/updates items -> stored in food_items collection)
router.post('/foods', authMiddleware, requireRestaurant, async (req, res, next) => {
    await invalidateCache('restaurant_menu:*');
    await invalidateCache('restaurants:*');
    next();
}, createRestaurantFoodController);
router.patch('/foods/:id', authMiddleware, requireRestaurant, async (req, res, next) => {
    await invalidateCache('restaurant_menu:*');
    await invalidateCache('restaurants:*');
    next();
}, updateRestaurantFoodController);

// Bulk Menu Upload
router.get('/bulk-upload/template', authMiddleware, requireRestaurant, downloadBulkMenuTemplateController);
router.post('/bulk-upload', authMiddleware, requireRestaurant, upload.single('file'), uploadBulkMenuController);

// Add-ons (restaurant dashboard) - approval handled by admin
router.get('/addons', authMiddleware, requireRestaurant, listAddonsController);
router.post('/addons', authMiddleware, requireRestaurant, createAddonController);
router.patch('/addons/:id', authMiddleware, requireRestaurant, updateAddonController);
router.delete('/addons/:id', authMiddleware, requireRestaurant, deleteAddonController);

// Orders (restaurant dashboard)
router.get('/orders', authMiddleware, requireRestaurant, orderController.listOrdersRestaurantController);
router.get('/orders/:orderId', authMiddleware, requireRestaurant, orderController.getOrderByIdRestaurantController);
router.patch('/orders/:orderId/status', authMiddleware, requireRestaurant, orderController.updateOrderStatusRestaurantController);
router.post('/orders/:orderId/resend-notification', authMiddleware, requireRestaurant, orderController.resendDeliveryNotificationRestaurantController);

// Complaints (restaurant dashboard)
router.get('/complaints', authMiddleware, requireRestaurant, getRestaurantComplaintsController);
router.post('/support/tickets', authMiddleware, requireRestaurant, createRestaurantSupportTicketController);
router.get('/support/tickets', authMiddleware, requireRestaurant, listRestaurantSupportTicketsController);

// Offers (restaurant dashboard)
router.get('/my-offers', authMiddleware, requireRestaurant, listRestaurantOffersController);
router.post('/my-offers', authMiddleware, requireRestaurant, createRestaurantOfferController);
router.patch('/my-offers/:id/status', authMiddleware, requireRestaurant, updateRestaurantOfferStatusController);
router.delete('/my-offers/:id', authMiddleware, requireRestaurant, deleteRestaurantOfferController);

export default router;

