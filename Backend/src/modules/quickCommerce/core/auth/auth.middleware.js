import { verifyAccessToken } from './token.util.js';
import { sendError } from '../../utils/response.js';
import { FoodUser } from '../users/user.model.js';
import { FoodRestaurant } from '../../modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../../modules/food/delivery/models/deliveryPartner.model.js';
import {
    resolveSharedCustomer,
    resolveSharedDeliveryPartner
} from '../../utils/identityBridge.js';

export const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'ADMIN') {
        return sendError(res, 403, 'Admin access required');
    }
    next();
};

/**
 * Accounts whose sessions are single-device.
 *
 * Admins are intentionally absent: the panel is routinely used across several
 * browser tabs and machines, so evicting the others on each sign-in would be a
 * regression rather than a safeguard.
 */
const SESSION_SCOPED_MODELS = {
    USER: FoodUser,
    RESTAURANT: FoodRestaurant,
    DELIVERY_PARTNER: FoodDeliveryPartner
};

/**
 * Bridges available per role, for a token that verified but named a document
 * this fork does not own. RESTAURANT is absent on purpose -- a food restaurant
 * is not a quick-commerce shop, so it registers explicitly. See
 * `utils/identityBridge.js`.
 */
const IDENTITY_BRIDGES = {
    USER: resolveSharedCustomer,
    DELIVERY_PARTNER: resolveSharedDeliveryPartner
};

export const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return sendError(res, 401, 'Authentication token missing');
    }

    let decoded;
    try {
        decoded = verifyAccessToken(token);
    } catch (error) {
        return sendError(res, 401, 'Invalid or expired token');
    }

    req.user = {
        userId: decoded.userId,
        role: decoded.role,
        adminType: decoded.adminType
    };

    const model = SESSION_SCOPED_MODELS[decoded.role];
    if (!model) return next();

    try {
        // One indexed lookup of two small fields. USER already paid for this to
        // check isActive; the version travels in the same query rather than a
        // second round trip, and the other two roles now share the same path.
        const doc = await model
            .findById(decoded.userId)
            .select('isActive tokenVersion')
            .lean();

        if (!doc) {
            // The token verified, so it was minted by something holding the
            // shared JWT secret -- i.e. master. It names a row in `users` /
            // `food_delivery_partners` while this fork reads `qc_*`. Bridge it
            // (provisioning on first use) so one login serves food, taxi and
            // quick. A QC-native token resolved above and never gets here.
            const bridge = IDENTITY_BRIDGES[decoded.role];
            const bridged = bridge ? await bridge(decoded.userId) : null;
            if (!bridged) return sendError(res, 401, 'Account not found');

            // The rest of the request must act as the QC identity: every QC
            // document -- orders, cart, wallet, dispatch -- is keyed by a
            // `qc_*` _id, and the socket rooms the server emits to follow it.
            req.user.userId = bridged._id.toString();
            // Flagged so downstream handlers can tell a bridged caller from a
            // QC-native one without re-querying.
            req.user.bridged = true;

            if (decoded.role === 'USER' && bridged.isActive === false) {
                return sendError(res, 401, 'User account is deactivated');
            }

            // No tokenVersion check for bridged identities: the version in a
            // master token tracks the MASTER account's device sessions, and the
            // freshly provisioned QC row starts at 0. Comparing them would 401
            // every bridged caller. Master already enforced single-device at
            // the point the token was issued.
            return next();
        }

        if (decoded.role === 'USER' && doc.isActive === false) {
            return sendError(res, 401, 'User account is deactivated');
        }

        // A token minted before the latest login belongs to a device that has
        // since been replaced.
        //
        // Tokens issued BEFORE this feature shipped carry no version at all.
        // Treating those as 0 would sign every existing user out the moment a
        // single new login bumped anyone; instead they are accepted until the
        // account next logs in, which is when the eviction genuinely applies.
        const stored = Number(doc.tokenVersion) || 0;
        const presented = decoded.tokenVersion;
        if (presented !== undefined && Number(presented) !== stored) {
            return sendError(
                res,
                401,
                'You have been signed out because this account was used on another device'
            );
        }

        return next();
    } catch (error) {
        return sendError(res, 401, 'Authentication failed');
    }
};
export const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return next();
    }

    try {
        const decoded = verifyAccessToken(token);
        req.user = {
            userId: decoded.userId,
            role: decoded.role,
            adminType: decoded.adminType
        };
        next();
    } catch (error) {
        // Silently ignore invalid tokens in optional auth
        next();
    }
};
