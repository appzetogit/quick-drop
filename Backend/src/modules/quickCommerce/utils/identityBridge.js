/**
 * Identity bridge: master collections -> quick-commerce collections.
 *
 * Quick-commerce arrived as a fork of the food backend, so it kept its own
 * identity tables (`QUICK_COMMERCE_INTEGRATION_PLAN.md` §4 deliberately started
 * on `qc_users` rather than shipping an identity merge on day one):
 *
 *   role              master collection          quick-commerce collection
 *   USER              users                      qc_users
 *   DELIVERY_PARTNER  food_delivery_partners     qc_delivery_partners
 *   RESTAURANT        food_restaurants           qc_restaurants
 *
 * The JWT secret is shared -- both sides resolve `JWT_ACCESS_SECRET` through
 * `config/env.js` -- so a master-issued token VERIFIES here. It just names a
 * document in the master collection while QC reads the `qc_*` one, and the
 * lookup in `auth.middleware.js` returns null. Without a bridge every QC call
 * from the super app or the driver app 401s with "Account not found".
 *
 * This is the same shape as the service-provider bridge
 * (`modules/serviceProvider/utils/identityBridge.js`) and the driver identity
 * bridge documented in `docs/superapp/13-driver-identity-bridge.md`: resolve in
 * the middleware, keep ONE login and ONE token. The alternative -- minting a
 * second QC token and having each app hold both -- was rejected there for
 * forcing two sessions that expire out of step.
 *
 * Properties:
 *  - Additive. A QC-native token resolves through the normal `findById` path
 *    and never reaches this file.
 *  - Matched on the last 10 digits of the phone, so `+91XXXXXXXXXX`,
 *    `91XXXXXXXXXX` and `XXXXXXXXXX` are one account.
 *  - Auto-provisions on first use, so an existing customer can open the Quick
 *    tab, and an approved driver can flip the QC toggle, without registering
 *    a second time.
 *
 * RESTAURANT is deliberately NOT bridged -- see `resolveSharedRestaurant`.
 */

import { FoodUser as QCUser } from '../core/users/user.model.js';
import { FoodDeliveryPartner as QCDeliveryPartner } from '../modules/food/delivery/models/deliveryPartner.model.js';

import { FoodUser as MasterUser } from '../../../core/users/user.model.js';
import { FoodDeliveryPartner as MasterDeliveryPartner } from '../../../modules/food/delivery/models/deliveryPartner.model.js';

/** Last 10 digits, or null when there aren't 10. Mirrors `utils/phone.util.js`. */
export const toTenDigits = (phone) => {
    if (!phone) return null;
    const digits = String(phone).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : null;
};

/** The three shapes a phone may have been stored in across the two forks. */
const phoneVariants = (tenDigits) => [
    { phone: tenDigits },
    { phone: `+91${tenDigits}` },
    { phone: `91${tenDigits}` }
];

/**
 * Resolve a master-issued customer token to its QC user, provisioning on first
 * contact.
 *
 * @param {string} masterUserId `decoded.userId` from a master-issued token.
 * @returns {Promise<object|null>} A lean QC user, or null when the id belongs to
 *   neither collection (a genuinely dead token) or the account has no usable
 *   phone to key on.
 */
export const resolveSharedCustomer = async (masterUserId) => {
    if (!masterUserId) return null;

    const shared = await MasterUser.findById(masterUserId)
        .select('name phone email countryCode')
        .lean()
        .catch(() => null);
    if (!shared) return null;

    const phone = toTenDigits(shared.phone);
    if (!phone) {
        console.warn(`[QC identity bridge] master user ${masterUserId} has no usable phone; not bridging`);
        return null;
    }

    const existing = await QCUser.findOne({ $or: phoneVariants(phone) })
        .select('-password')
        .lean();
    if (existing) return existing;

    try {
        // `phone` is the only required field on the QC user schema; `name` is
        // optional there, so it is carried across when present rather than
        // defaulted to a placeholder the customer would then have to correct.
        const created = await QCUser.create({
            phone,
            countryCode: shared.countryCode || '+91',
            name: (shared.name && shared.name.trim()) || undefined,
            email: shared.email || undefined,
            isPhoneVerified: true
        });
        console.log(`[QC identity bridge] provisioned qc_user ${created._id} for master user ${masterUserId}`);
        const { password, ...rest } = created.toObject();
        return rest;
    } catch (error) {
        // A concurrent first request can lose the unique-index race. The other
        // one won and the document now exists, so read it back.
        if (error && error.code === 11000) {
            return QCUser.findOne({ $or: phoneVariants(phone) }).select('-password').lean();
        }
        console.error('[QC identity bridge] customer provisioning failed:', error.message);
        return null;
    }
};

/**
 * Resolve a master-issued delivery-partner token to its QC delivery partner.
 *
 * This is what makes the driver app's Quick toggle work: the driver signs in
 * once against master, flips the toggle, and their first call to
 * `/api/v1/qc/delivery/*` provisions the matching `qc_delivery_partners`
 * record. No second registration, no second document to keep approved.
 *
 * Approval is INHERITED, not granted: a partner who is `approved` on master is
 * approved here, and anyone else lands as `pending`. Auto-approving everyone
 * who happens to hold a token would put unvetted riders in the QC dispatch
 * pool, which is a safety decision the bridge has no business making.
 *
 * @param {string} masterPartnerId `decoded.userId` from a master-issued token.
 * @returns {Promise<object|null>}
 */
export const resolveSharedDeliveryPartner = async (masterPartnerId) => {
    if (!masterPartnerId) return null;

    const shared = await MasterDeliveryPartner.findById(masterPartnerId)
        .select('name phone email countryCode status vehicleType vehicleName vehicleNumber profilePhoto city state')
        .lean()
        .catch(() => null);
    if (!shared) return null;

    const phone = toTenDigits(shared.phone);
    if (!phone) {
        console.warn(`[QC identity bridge] master delivery partner ${masterPartnerId} has no usable phone; not bridging`);
        return null;
    }

    const existing = await QCDeliveryPartner.findOne({ $or: phoneVariants(phone) })
        .select('-password')
        .lean();
    if (existing) return existing;

    try {
        // `name` and `phone` are both required on the QC partner schema, hence
        // the name fallback. The vehicle fields are copied because QC's order
        // cards render them, and an empty card reads as a broken account.
        const created = await QCDeliveryPartner.create({
            name: (shared.name && shared.name.trim()) || 'Delivery Partner',
            phone,
            countryCode: shared.countryCode || '+91',
            email: shared.email || undefined,
            city: shared.city || undefined,
            state: shared.state || undefined,
            vehicleType: shared.vehicleType || undefined,
            vehicleName: shared.vehicleName || undefined,
            vehicleNumber: shared.vehicleNumber || undefined,
            profilePhoto: shared.profilePhoto || undefined,
            status: shared.status === 'approved' ? 'approved' : 'pending',
            approvedAt: shared.status === 'approved' ? new Date() : undefined,
            // Provisioning must never make a rider look available. The driver
            // app sets this explicitly when the Quick toggle goes on.
            availabilityStatus: 'offline'
        });
        console.log(
            `[QC identity bridge] provisioned qc_delivery_partner ${created._id} ` +
            `for master partner ${masterPartnerId} (status: ${created.status})`
        );
        const { password, ...rest } = created.toObject();
        return rest;
    } catch (error) {
        if (error && error.code === 11000) {
            return QCDeliveryPartner.findOne({ $or: phoneVariants(phone) }).select('-password').lean();
        }
        console.error('[QC identity bridge] delivery partner provisioning failed:', error.message);
        return null;
    }
};

/**
 * Restaurants are NOT bridged, and that is a product decision rather than an
 * omission.
 *
 * A food restaurant is not a quick-commerce shop: different catalogue, different
 * fulfilment, different onboarding paperwork. Auto-provisioning a QC shop for
 * every restaurant that holds a token would put empty storefronts in the
 * customer app. The seller app therefore offers the two account types as an
 * explicit choice at login, and a QC shop registers through
 * `POST /api/v1/qc/restaurant/register` and receives a QC-issued token.
 *
 * Exported as an explicit null so a future caller finds this note rather than
 * assuming the case was overlooked.
 */
export const resolveSharedRestaurant = async () => null;
