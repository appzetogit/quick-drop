import mongoose from 'mongoose';
import { logger } from '../../utils/logger.js';

/**
 * One person, one registration, both job streams.
 *
 * A driver registering in the app becomes a unified TaxiDriver. That identity
 * owns the busy-lock and the workMode toggle, but it is NOT the pool food
 * dispatch selects from: order-dispatch.service.js still picks candidates out of
 * FoodDeliveryPartner and only *filters* them by the linked driver. So granting
 * the 'delivery' capability alone puts nobody in the food pool -- the driver
 * would toggle to Delivery and simply never be offered anything.
 *
 * This creates the other half and links the two, which is what the Phase-1
 * backfill (scripts/migrate-unify-drivers.js) does for existing records. Same
 * shape, applied forward at registration instead of retroactively.
 *
 * Idempotent: safe to call on every registration and safe to re-run over
 * drivers that already have both halves.
 *
 * Deliberately non-fatal. A driver who cannot be given delivery capability must
 * still finish registering as a taxi driver -- failing the whole signup because
 * the second identity could not be written would be worse than the missing
 * capability, which a backfill can repair later.
 */

const normalizePhone = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/**
 * Give a unified driver the delivery half: capability, a linked
 * FoodDeliveryPartner, and the dispatch hints food matching reads off the core doc.
 *
 * @param {object} driver  a TaxiDriver mongoose document (saved)
 * @returns {Promise<{ granted: boolean, partnerId: string|null, reason?: string }>}
 */
export async function ensureDeliveryCapability(driver) {
    try {
        if (!driver?._id) return { granted: false, partnerId: null, reason: 'no driver' };

        const phone = normalizePhone(driver.phone);
        if (!phone) return { granted: false, partnerId: null, reason: 'driver has no phone' };

        const { FoodDeliveryPartner } = await import('../../modules/food/delivery/models/deliveryPartner.model.js');

        // Match on the last 10 digits, because the two apps store country codes
        // differently and a '+91' prefix would otherwise create a duplicate
        // partner for someone who already exists.
        let partner = await FoodDeliveryPartner.findOne({
            phone: { $regex: `${phone}$` },
        });

        if (!partner) {
            partner = await FoodDeliveryPartner.create({
                name: driver.name || driver.fullName || 'Driver',
                phone,
                countryCode: driver.countryCode || '+91',
                email: driver.email || undefined,
                vehicleType: driver.delivery?.vehicleType || '',
                vehicleName: driver.delivery?.vehicleName || driver.vehicleName || '',
                // vehicleNumber is unique+sparse: writing an empty string on every
                // auto-created partner would collide on the second one, so it is
                // left unset unless we actually have a value.
                ...(driver.vehicleNumber ? { vehicleNumber: driver.vehicleNumber } : {}),
                // Mirrors the taxi approval state rather than assuming approved:
                // a driver still pending verification must not receive orders.
                status: driver.approve === true ? 'approved' : 'pending',
                driverId: driver._id,
            });
        } else if (!partner.driverId) {
            partner.driverId = driver._id;
            await partner.save();
        }

        // Link and capability on the driver side.
        const caps = Array.isArray(driver.serviceCapabilities) ? [...driver.serviceCapabilities] : [];
        let changed = false;

        if (!caps.includes('delivery')) {
            caps.push('delivery');
            driver.serviceCapabilities = caps;
            changed = true;
        }
        if (!caps.includes('taxi')) {
            // Registration is through the driver app, which is a taxi identity;
            // without this a delivery-first signup could never toggle to rides.
            driver.serviceCapabilities = [...caps, 'taxi'];
            changed = true;
        }
        if (String(driver.legacyDeliveryPartnerId || '') !== String(partner._id)) {
            driver.legacyDeliveryPartnerId = partner._id;
            changed = true;
        }
        if (changed) await driver.save();

        // The per-service profile the unification design expects. Not read by
        // dispatch today, but the backfill creates one and the two paths should
        // not disagree about what a unified driver looks like.
        try {
            const { DeliveryProfile } = await import('../../modules/food/delivery/models/deliveryProfile.model.js');
            await DeliveryProfile.updateOne(
                { driverId: driver._id },
                { $setOnInsert: { driverId: driver._id, legacyDeliveryPartnerId: partner._id } },
                { upsert: true }
            );
        } catch (err) {
            logger.warn(`DeliveryProfile upsert skipped for driver ${driver._id}: ${err.message}`);
        }

        return { granted: true, partnerId: String(partner._id) };
    } catch (err) {
        // Never fail a registration over this.
        logger.error(`ensureDeliveryCapability failed for driver ${driver?._id}: ${err.message}`);
        return { granted: false, partnerId: null, reason: err.message };
    }
}

/**
 * Keep the delivery half's approval in step when a driver is approved or
 * suspended on the taxi side, so one decision does not leave the person able to
 * take food orders while barred from rides.
 */
export async function syncDeliveryApproval(driver) {
    try {
        if (!driver?.legacyDeliveryPartnerId) return false;
        const { FoodDeliveryPartner } = await import('../../modules/food/delivery/models/deliveryPartner.model.js');
        await FoodDeliveryPartner.updateOne(
            { _id: driver.legacyDeliveryPartnerId },
            { $set: { status: driver.approve === true ? 'approved' : 'pending' } }
        );
        return true;
    } catch (err) {
        logger.error(`syncDeliveryApproval failed for driver ${driver?._id}: ${err.message}`);
        return false;
    }
}

export const __testables = { normalizePhone };
