import {
    registerRestaurant,
    listApprovedRestaurants,
    getApprovedRestaurantByIdOrSlug,
    getCurrentRestaurantProfile,
    updateRestaurantProfile,
    updateRestaurantAcceptingOrders,
    updateCurrentRestaurantDiningSettings,
    uploadRestaurantProfileImage,
    uploadRestaurantMenuImage,
    uploadRestaurantCoverImages,
    uploadRestaurantMenuImages,
    uploadRestaurantAttachment,
    listPublicOffers,
    getRestaurantComplaints,
    deleteCurrentRestaurantAccount
} from '../services/restaurant.service.js';
import { validateRestaurantRegisterDto } from '../validators/restaurant.validator.js';
import { sendResponse } from '../../../../utils/response.js';

export const uploadRestaurantAttachmentController = async (req, res, next) => {
    try {
        const { folder } = req.body;
        const result = await uploadRestaurantAttachment(req.file, folder);
        return sendResponse(res, 200, 'Image uploaded successfully', result);
    } catch (error) {
        next(error);
    }
};

export const registerRestaurantController = async (req, res, next) => {
    try {
        const validated = validateRestaurantRegisterDto(req.body);
        const restaurant = await registerRestaurant(validated, req.files);
        return sendResponse(res, 201, 'Restaurant registered successfully', restaurant);
    } catch (error) {
        next(error);
    }
};

export const listApprovedRestaurantsController = async (req, res, next) => {
    try {
        const data = await listApprovedRestaurants(req.query);
        return sendResponse(res, 200, 'Restaurants fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const getApprovedRestaurantController = async (req, res, next) => {
    try {
        const restaurant = await getApprovedRestaurantByIdOrSlug(req.params.id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }
        return sendResponse(res, 200, 'Restaurant fetched successfully', { restaurant });
    } catch (error) {
        next(error);
    }
};

export const getCurrentRestaurantController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const restaurant = await getCurrentRestaurantProfile(restaurantId);
        return sendResponse(res, 200, 'Restaurant fetched successfully', { restaurant });
    } catch (error) {
        next(error);
    }
};

/**
 * The commission rate that currently applies to this restaurant.
 *
 * Exposed so the item form can show what a dish actually earns before the
 * restaurant saves a price, rather than making them discover it on a payout.
 * Resolved through the same path an order uses -- including any dated override
 * in effect right now -- so the number shown is the number that would be
 * charged, not an approximation of it.
 *
 * The rate is returned rather than a computed amount: the form recalculates on
 * every keystroke, and a round trip per character would be both slow and
 * pointless when the arithmetic is a multiplication.
 */
export const getRestaurantCommissionRateController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const { getRestaurantCommissionSnapshot } = await import(
            '../../orders/services/foodTransaction.service.js'
        );

        // A synthetic order of 100 so a percentage rate reads directly, and a
        // flat rate comes back as its own amount either way.
        const snapshot = await getRestaurantCommissionSnapshot({
            restaurantId,
            pricing: { subtotal: 100 },
        });

        return sendResponse(res, 200, 'Commission fetched successfully', {
            commissionType: snapshot.commissionType,
            commissionValue: snapshot.commissionValue,
            commissionLabel: snapshot.commissionLabel || '',
            commissionSource: snapshot.commissionSource,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * The restaurant's own "spend this much, get this free" ladder.
 *
 * The same document the admin panel edits, so whichever side saves last wins and
 * neither can end up looking at a different offer than the one being applied.
 */
export const getFreebieOfferController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const { getFreebieOffer } = await import('../../shared/freebieOffer.service.js');
        const offer = await getFreebieOffer(restaurantId);
        return sendResponse(res, 200, 'Freebie offer fetched successfully', {
            offer: offer || { restaurantId, isActive: true, tiers: [] },
        });
    } catch (error) {
        next(error);
    }
};

export const updateFreebieOfferController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const { normalizeFreebieTiersInput } = await import('../../shared/freebieRewards.js');
        const { saveFreebieOffer } = await import('../../shared/freebieOffer.service.js');

        let tiers;
        try {
            tiers = normalizeFreebieTiersInput(req.body || {})?.tiers;
        } catch (validationError) {
            return sendResponse(res, 400, validationError.message, null);
        }

        const offer = await saveFreebieOffer(restaurantId, {
            tiers,
            isActive: req.body?.isActive,
            updatedByRole: 'RESTAURANT',
        });
        return sendResponse(res, 200, 'Freebie offer saved successfully', { offer });
    } catch (error) {
        next(error);
    }
};

export const updateRestaurantProfileController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const restaurant = await updateRestaurantProfile(restaurantId, req.body || {});
        return sendResponse(res, 200, 'Restaurant updated successfully', { restaurant });
    } catch (error) {
        next(error);
    }
};

export const updateRestaurantAcceptingOrdersController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const restaurant = await updateRestaurantAcceptingOrders(restaurantId, req.body?.isAcceptingOrders);
        return sendResponse(res, 200, 'Restaurant availability updated successfully', { restaurant });
    } catch (error) {
        next(error);
    }
};

export const updateCurrentRestaurantDiningSettingsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const restaurant = await updateCurrentRestaurantDiningSettings(restaurantId, req.body || {});
        return sendResponse(res, 200, 'Dining settings updated successfully', { restaurant });
    } catch (error) {
        next(error);
    }
};

export const uploadRestaurantProfileImageController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const result = await uploadRestaurantProfileImage(restaurantId, req.file);
        return sendResponse(res, 200, 'Profile image uploaded successfully', result);
    } catch (error) {
        next(error);
    }
};

export const uploadRestaurantMenuImageController = async (req, res, next) => {
    try {
        const result = await uploadRestaurantMenuImage(req.file);
        return sendResponse(res, 200, 'Menu image uploaded successfully', result);
    } catch (error) {
        next(error);
    }
};

export const uploadRestaurantCoverImagesController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const result = await uploadRestaurantCoverImages(restaurantId, req.files || []);
        return sendResponse(res, 200, 'Restaurant photos uploaded successfully', result);
    } catch (error) {
        next(error);
    }
};

export const uploadRestaurantMenuImagesController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const result = await uploadRestaurantMenuImages(restaurantId, req.files || []);
        return sendResponse(res, 200, 'Menu photos uploaded successfully', result);
    } catch (error) {
        next(error);
    }
};

export const listPublicOffersController = async (req, res, next) => {
    try {
        const data = await listPublicOffers(req.query || {});
        return sendResponse(res, 200, 'Offers fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const getRestaurantComplaintsController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const data = await getRestaurantComplaints(restaurantId, req.query || {});
        return sendResponse(res, 200, 'Complaints fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const deleteCurrentRestaurantAccountController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const result = await deleteCurrentRestaurantAccount(restaurantId);
        return sendResponse(res, 200, 'Restaurant account deleted successfully', result);
    } catch (error) {
        next(error);
    }
};

import { FoodOrder } from '../../orders/models/order.model.js';

export const getRestaurantPublicReviewsController = async (req, res, next) => {
    try {
        const restaurant = await getApprovedRestaurantByIdOrSlug(req.params.id);
        if (!restaurant) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }
        
        const restaurantId = restaurant._id;
        const reviews = await FoodOrder.find({
            restaurantId,
            'ratings.restaurant.rating': { $exists: true, $ne: null }
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('userId', 'name')
        .lean();
        
        const formattedReviews = reviews.map(order => ({
            id: order._id,
            userName: order.userId?.name || 'Anonymous Customer',
            rating: order.ratings?.restaurant?.rating,
            comment: order.ratings?.restaurant?.comment || 'No comment provided',
            date: order.createdAt
        }));
        
        return sendResponse(res, 200, 'Reviews fetched successfully', { reviews: formattedReviews });
    } catch (error) {
        next(error);
    }
};
