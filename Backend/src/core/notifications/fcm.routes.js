import express from 'express';
import { sendError } from '../../utils/response.js';
import {
    removeFirebaseDeviceToken,
    sendTestNotification,
    upsertFirebaseDeviceToken
} from './firebase.service.js';
import { verifyAccessToken as verifyCoreAccessToken } from '../auth/token.util.js';
import { verifyAccessToken as verifyTaxiAccessToken } from '../../modules/taxi/services/tokenService.js';
import { FoodUser } from '../users/user.model.js';

const router = express.Router();

const MAX_TOKEN_LENGTH = 4096;
const ROLE_TO_OWNER_TYPE = {
    USER: 'USER',
    user: 'USER',
    RESTAURANT: 'RESTAURANT',
    restaurant: 'RESTAURANT',
    DELIVERY_PARTNER: 'DELIVERY_PARTNER',
    delivery_partner: 'DELIVERY_PARTNER',
    delivery: 'DELIVERY_PARTNER',
    ADMIN: 'ADMIN',
    admin: 'ADMIN',
    driver: 'DRIVER',
    owner: 'OWNER',
    bus_driver: 'BUS_DRIVER',
    service_center: 'SERVICE_CENTER',
    service_center_staff: 'SERVICE_CENTER_STAFF'
};

const resolveOwnerType = (role) => ROLE_TO_OWNER_TYPE[String(role || '').trim()] || null;

const unifiedAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : '';

    if (!token) {
        return sendError(res, 401, 'Authentication token missing');
    }

    const tokenVerifiers = [verifyCoreAccessToken, verifyTaxiAccessToken];
    for (const verifyToken of tokenVerifiers) {
        try {
            const decoded = verifyToken(token);
            const role = String(decoded?.role || '').trim();
            const userId = String(decoded?.userId || decoded?.sub || decoded?.id || '').trim();
            const ownerType = resolveOwnerType(role);

            if (!ownerType || !userId) {
                continue;
            }

            req.user = {
                userId,
                role,
                ownerType
            };
            return next();
        } catch (_error) {
            // Try next verifier
        }
    }

    return sendError(res, 401, 'Invalid or expired token');
};

const getOwnerContext = (req) => ({
    ownerType: req.user?.ownerType || resolveOwnerType(req.user?.role),
    ownerId: req.user?.userId
});

const readTokenFromBody = (req) => String(req.body?.token || '').trim();

const validateToken = (token) => {
    if (!token) return 'FCM token is required';
    if (token.length < 20) return 'FCM token looks invalid';
    if (token.length > MAX_TOKEN_LENGTH) return 'FCM token is too long';
    return null;
};

// Public health check for fcm-tokens service
router.get('/check', (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'FCM tokens service is operational',
        timestamp: new Date().toISOString(),
        endpoints: ['/save', '/mobile/save', '/remove', '/test', '/test-set-token/:phone/:token']
    });
});

// Temporary administrative test route to set token by phone
router.get('/test-set-token/:phone/:token', async (req, res, next) => {
    try {
        const { phone, token } = req.params;
        const user = await FoodUser.findOne({ phone: phone.trim() });
        if (!user) return res.status(404).json({ success: false, message: `User with phone ${phone} not found` });

        await upsertFirebaseDeviceToken({ 
            ownerType: 'USER', 
            ownerId: String(user._id), 
            token, 
            platform: 'mobile' 
        });

        return res.status(200).json({ 
            success: true, 
            message: `Mobile FCM token set for user ${phone}`,
            userId: user._id
        });
    } catch (error) {
        next(error);
    }
});

// Temporary administrative test route to get tokens by phone
router.get('/test-get-token/:phone', async (req, res, next) => {
    try {
        const { phone } = req.params;
        const user = await FoodUser.findOne({ phone: phone.trim() }).select('fcmTokens fcmTokenMobile');
        if (!user) return res.status(404).json({ success: false, message: `User with phone ${phone} not found` });

        return res.status(200).json({ 
            success: true, 
            data: {
                web: user.fcmTokens || [],
                mobile: user.fcmTokenMobile || []
            }
        });
    } catch (error) {
        next(error);
    }
});

router.post('/save', unifiedAuthMiddleware, async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const token = readTokenFromBody(req);
        const platform = String(req.body?.platform || '').trim();

        if (!ownerType || !ownerId) {
            return sendError(res, 401, 'Authentication required');
        }
        if (platform !== 'web') {
            return sendError(res, 400, 'platform must be "web" for this endpoint');
        }
        const tokenError = validateToken(token);
        if (tokenError) {
            return sendError(res, 400, tokenError);
        }

        await upsertFirebaseDeviceToken({ ownerType, ownerId, token, platform: 'web' });
        return res.status(200).json({
            success: true,
            message: 'FCM token saved',
            data: { ownerType, ownerId, platform }
        });
    } catch (error) {
        next(error);
    }
});

router.post('/mobile/save', unifiedAuthMiddleware, async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const token = readTokenFromBody(req);

        if (!ownerType || !ownerId) {
            return sendError(res, 401, 'Authentication required');
        }

        if (req.body?.platform !== undefined) {
            return sendError(res, 400, 'platform is not allowed on this endpoint');
        }
        const tokenError = validateToken(token);
        if (tokenError) {
            return sendError(res, 400, tokenError);
        }

        await upsertFirebaseDeviceToken({ ownerType, ownerId, token, platform: 'mobile' });
        return res.status(200).json({
            success: true,
            message: 'Mobile FCM token saved successfully',
            data: { ownerType, ownerId, platform: 'mobile' }
        });
    } catch (error) {
        next(error);
    }
});

const handleRemoveToken = async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const token = String(req.params?.token || req.body?.token || '').trim();
        const platform = req.body?.platform === 'mobile' ? 'mobile' : req.body?.platform === 'web' ? 'web' : undefined;

        if (!ownerType || !ownerId) {
            return sendError(res, 401, 'Authentication required');
        }
        const tokenError = validateToken(token);
        if (tokenError) {
            return sendError(res, 400, tokenError);
        }

        await removeFirebaseDeviceToken({ ownerType, ownerId, token, platform });
        return res.status(200).json({
            success: true,
            message: 'FCM token removed'
        });
    } catch (error) {
        next(error);
    }
};

router.delete('/remove', unifiedAuthMiddleware, handleRemoveToken);
router.delete('/remove/:token', unifiedAuthMiddleware, handleRemoveToken);

router.post('/test', unifiedAuthMiddleware, async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const platform = req.body?.platform === 'mobile' ? 'mobile' : req.body?.platform === 'web' ? 'web' : undefined;

        if (!ownerType || !ownerId) {
            return sendError(res, 401, 'Authentication required');
        }

        const result = await sendTestNotification({ ownerType, ownerId, platform });
        return res.status(200).json({
            success: true,
            message: 'Test notification sent',
            data: result
        });
    } catch (error) {
        next(error);
    }
});

export default router;
