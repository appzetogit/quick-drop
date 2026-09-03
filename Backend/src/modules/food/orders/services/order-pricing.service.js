import mongoose from 'mongoose';
import { FoodOrder } from '../models/order.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodFeeSettings } from '../../admin/models/feeSettings.model.js';
import { FoodOffer } from '../../admin/models/offer.model.js';
import { FoodOfferUsage } from '../../admin/models/offerUsage.model.js';
import { FoodDeliverySurgeZone } from '../../admin/models/deliverySurgeZone.model.js';
import { FoodDeliveryCommissionRule } from '../../admin/models/deliveryCommissionRule.model.js';
import { FoodZone } from '../../admin/models/zone.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { resolveDeliveryDistanceKm } from './deliveryDistance.service.js';
import {
    assertOrderQuantity,
    resolveOrderQuantityRules
} from '../../shared/orderQuantityRules.js';
import {
    computeFoodPackagingFee,
    normalizePackagingConfig,
    resolveItemPackagingAmount
} from '../../shared/packagingCharge.js';
import { assertFoodAvailableNow } from '../../shared/itemAvailability.js';
import { resolveFreebieForOrder } from '../../shared/freebieOffer.service.js';
import { applyBogoToItems } from '../../shared/bogoOffer.service.js';
import { computeSellingPrice } from '../../shared/itemDiscountPricing.js';
import { getOrderQuantityCeiling } from '../../shared/orderQuantityCeiling.js';
import { FoodAddon } from '../../restaurant/models/foodAddon.model.js';
import { loadSellableAddons, normalizeRequestedAddonIds, resolveLineAddons } from '../../shared/orderAddons.js';

/**
 * Resolves order items against the restaurant's live menu and returns copies with
 * SERVER-authoritative prices/names. Never trust client-supplied prices: without this
 * a client could post price:1 for an expensive dish and be charged ₹1.
 * Also validates ownership, availability, variant, and quantity bounds.
 * @param {string|import('mongoose').Types.ObjectId} restaurantId
 * @param {Array<object>} items
 * @returns {Promise<Array<object>>}
 */
export async function resolveAuthoritativeItems(restaurantId, items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) throw new ValidationError('Order must contain at least one item');

  const ids = [...new Set(list.map((it) => String(it?.itemId || '')).filter(Boolean))]
    .filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) throw new ValidationError('Invalid order items');

  const menuItems = await FoodItem.find({ _id: { $in: ids }, restaurantId }).lean();
  const byId = new Map(menuItems.map((m) => [String(m._id), m]));

  // Admin-configurable platform cap, read once for the whole order rather than
  // per line -- it is the same value for every item and the map below is sync.
  const quantityCeiling = await getOrderQuantityCeiling();

  // Add-ons for every line, fetched in one query and validated per line below.
  // Loaded from the published records, so the price charged is the approved one
  // and never whatever the client sent.
  const requestedAddonsByLine = list.map((it) => normalizeRequestedAddonIds(it));
  const allAddonIds = [...new Set(requestedAddonsByLine.flat())];
  const addonsById = await loadSellableAddons(FoodAddon, restaurantId, allAddonIds);

  return list.map((it, index) => {
    const menu = byId.get(String(it?.itemId || ''));
    if (!menu) throw new ValidationError('One or more items are not available at this restaurant');
    if (menu.isActive === false || menu.isAvailable === false || menu.approvalStatus !== 'approved') {
      throw new ValidationError(`"${menu.name}" is currently unavailable`);
    }

    // Per-item serving window, e.g. breakfast only until 11:30. Checked against
    // the restaurant's wall clock, not the server's UTC one.
    assertFoodAvailableNow(menu);

    let price = Number(menu.price);
    let variantName = '';
    // A dish switched off variants keeps them stored but sells at its base
    // price. A variantId can still arrive -- a cart line added before the
    // toggle flipped -- and is ignored rather than refused, so a stale cart
    // gets charged the base price instead of failing at checkout. Rows written
    // before the flag existed have it undefined, which does NOT mean off:
    // for them, having variants means selling by variants, as it always did.
    const sellsByVariants = menu.variantsEnabled !== false;
    const chosenVariantId = sellsByVariants ? (it?.variantId || null) : null;
    if (chosenVariantId) {
      const variant = (menu.variants || []).find((v) => String(v._id) === String(chosenVariantId));
      if (!variant) throw new ValidationError(`Selected option for "${menu.name}" is not available`);
      // The item's discount is a single percentage that applies to whichever
      // option is chosen, so a variant is charged from its own price less that
      // discount. Taking variant.price raw would have billed the large size at
      // full price while the menu advertised it as discounted.
      price = computeSellingPrice(variant.price, menu.discountPercent) ?? Number(variant.price);
      variantName = variant.name;
    }

    // Min/max set by the restaurant, with the platform ceiling as fallback.
    //
    // Checked AFTER the size is known, because a variant may carry limits of its
    // own: a family pack capped at two must not be judged by the dish-level cap
    // of ten. A variant that sets none inherits the dish's, so a dish without
    // per-size limits behaves exactly as it did before.
    const qty = assertOrderQuantity(
      it?.quantity,
      resolveOrderQuantityRules(menu, quantityCeiling, chosenVariantId),
      variantName ? `${menu.name} (${variantName})` : menu.name,
    );

    // Add-ons the dish actually offers, priced from the published record. The
    // chosen variant is passed too: an add-on may be attached to one size only,
    // and without this a variant-only add-on would be refused on the very
    // variant it belongs to.
    const { addons, addonsTotal } = resolveLineAddons(
      menu,
      requestedAddonsByLine[index],
      addonsById,
      chosenVariantId,
    );

    return {
      ...it,
      itemId: menu._id,
      name: menu.name,
      price,
      quantity: qty,
      variantName: variantName || it?.variantName || '',
      // Per-unit packaging charge, stamped from the DB item — never client input.
      foodPackagingCharge: resolveItemPackagingAmount(menu),
      // Read from the menu, never the request: a client that could send
      // this would waive its own delivery fee.
      freeDelivery: menu.freeDelivery === true,
      // Snapshotted per unit, same as the packaging charge above.
      addons,
      addonsTotal,
      // A combo carries its parts so the kitchen knows what to make. Read from
      // the menu item, never the request: a client that could name its own
      // components would be choosing what it gets for the combo price.
      isCombo: menu.isCombo === true,
      comboComponents: menu.isCombo === true
        ? (menu.comboComponents || []).map((c) => ({
            itemId: String(c.itemId || ''),
            variantId: c.variantId ? String(c.variantId) : '',
            quantity: Number(c.quantity) || 1,
            name: c.nameSnapshot || '',
            variantName: c.variantNameSnapshot || '',
            listUnitPrice: Number(c.listUnitPrice) || 0,
            allocatedLineTotal: Number(c.allocatedLineTotal) || 0,
          }))
        : [],
    };
  });
}

function extractCoords(addressLike) {
  const coords = addressLike?.location?.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  return [Number(lng), Number(lat)];
}

function isPointInPolygon(lat, lng, polygon = []) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i]?.longitude);
    const yi = Number(polygon[i]?.latitude);
    const xj = Number(polygon[j]?.longitude);
    const yj = Number(polygon[j]?.latitude);
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

async function detectZoneIdFromAddress(addressLike) {
  const coords = extractCoords(addressLike);
  if (!coords) return null;
  const [lng, lat] = coords;
  const zones = await FoodZone.find({ isActive: true }).select('_id coordinates').lean();
  const matchedZone = (zones || []).find((zone) => isPointInPolygon(lat, lng, zone?.coordinates || []));
  return matchedZone?._id ? String(matchedZone._id) : null;
}

export async function resolveOrderZoneId(dto = {}, restaurant = null) {
  const detectedZoneId = await detectZoneIdFromAddress(dto?.address || dto?.deliveryAddress);
  if (detectedZoneId && mongoose.Types.ObjectId.isValid(detectedZoneId)) {
    return detectedZoneId;
  }
  if (dto?.zoneId && mongoose.Types.ObjectId.isValid(dto.zoneId)) {
    return String(dto.zoneId);
  }
  if (restaurant?.zoneId && mongoose.Types.ObjectId.isValid(restaurant.zoneId)) {
    return String(restaurant.zoneId);
  }
  return null;
}

async function resolveDistanceRule(distanceKm) {
  if (!Number.isFinite(Number(distanceKm)) || Number(distanceKm) < 0) return null;
  const rules = await FoodDeliveryCommissionRule.find({ status: { $ne: false } }).lean();
  if (!rules.length) return null;
  const d = Number(distanceKm);
  const sorted = [...rules].sort((a, b) => Number(a.minDistance || 0) - Number(b.minDistance || 0));
  const matched = sorted.find((r) => {
    const min = Number(r.minDistance || 0);
    const max = r.maxDistance == null ? null : Number(r.maxDistance);
    return d >= min && (max == null || d < max);
  });
  if (matched) return matched;

  const lowerRule = [...sorted]
    .reverse()
    .find((r) => d >= Number(r.minDistance || 0));

  return lowerRule || sorted[0] || null;
}

export async function calculateOrderPricing(userId, dto) {
  const restaurant = await FoodRestaurant.findById(dto.restaurantId)
    .select("status zoneId location")
    .lean();
  if (!restaurant) throw new ValidationError("Restaurant not found");
  if (restaurant.status !== "approved")
    throw new ValidationError("Restaurant not available");

  // Resolve prices from the live menu — never trust client-supplied item prices.
  const resolvedItems = await resolveAuthoritativeItems(dto.restaurantId, dto.items);

  // Buy-one-get-one, applied BEFORE the subtotal below rather than as a discount
  // after it. A qualifying line is split into a paid half and a zero-priced half,
  // so the free units are simply absent from the sum -- which is what keeps
  // commission (taken on pricing.subtotal) off food the restaurant gave away, and
  // keeps the POS payload, which is sent price x quantity per line, agreeing with
  // what we charged.
  //
  // Server-side because the free units are earned by quantity, not chosen: a
  // client asking for a free dish gets what its own order actually qualifies for.
  const { items, bogo } = await applyBogoToItems(dto.restaurantId, resolvedItems);
  dto.items = items;

  // Add-ons are priced per unit, so they scale with quantity exactly as the item
  // price does. Left out of this sum they would be shown on the order and in the
  // kitchen but never charged. Add-ons and packaging ride along on a free
  // buy-one-get-one unit at their real values, so they are still counted here:
  // only the item price was given away.
  const subtotal = items.reduce(
    (sum, it) => sum
      + ((Number(it.price) || 0) + (Number(it.addonsTotal) || 0)) * (Number(it.quantity) || 1),
    0,
  );

  // Spend-threshold reward, resolved AFTER the subtotal above and appended
  // without changing it. Order matters: counting the reward toward the amount
  // that earned it would let a zero-priced line push an order over a threshold
  // it never reached, and on a two-tier ladder that cascades.
  //
  // The subtotal it reads is already net of any buy-one-get-one units, which is
  // the same rule stated the other way round: the threshold is measured on what
  // the customer PAYS for, and a free second pizza is not paid for.
  //
  // Server-side because the reward is earned, not chosen -- a client asking for
  // a freebie, or for a costlier one than its order earned, gets what the
  // subtotal actually entitles it to.
  const { line: freebieLine, tier: freebieTier, nextTier: freebieNextTier } =
    await resolveFreebieForOrder(dto.restaurantId, subtotal);
  if (freebieLine) {
    items.push(freebieLine);
    dto.items = items;
  }

  const feeDoc = await FoodFeeSettings.findOne({ isActive: true })
    .sort({ createdAt: -1 })
    .lean();
    
  const feeSettings = feeDoc || {
    platformFee: 0,
    deliveryFeeComputationMode: 'distance_order_value',
    gstRate: 0,
    deliveryPartnerIncentiveRule: {
      isEnabled: false,
      minOrderAmount: 0,
      incentivePercent: 0,
    }
  };

  const { packagingFee } = computeFoodPackagingFee({
    items,
    config: normalizePackagingConfig(feeDoc),
  });
  const configuredPlatformFee = Number(feeSettings.platformFee);
  const platformFee = (!Number.isFinite(configuredPlatformFee) || configuredPlatformFee < 0)
    ? 0
    : Math.round(configuredPlatformFee * 100) / 100;

  const incentiveRule = feeSettings.deliveryPartnerIncentiveRule || {
    isEnabled: false,
    minOrderAmount: 0,
    incentivePercent: 0,
  };

  const mode = String(feeSettings.deliveryFeeComputationMode || '');
  let deliveryFee = 0;
  let deliveryFeeBreakdown = null;
  let adminDeliveryCommissionPercent = 0;
  let adminDeliveryCommissionAmount = 0;
  let riderDeliveryEarningAfterAdminCommission = 0;
  let adminDeliveryCommissionEnabled = false;
  let deliveryPartnerIncentiveEnabled = Boolean(incentiveRule.isEnabled);
  let deliveryPartnerIncentivePercent = Math.round((Number(incentiveRule.incentivePercent || 0) * 100)) / 100;
  let deliveryPartnerIncentiveAmount = 0;
  let deliveryPartnerIncentiveEligible = false;
  // Hoisted: the free-delivery radius rule below is judged on the SAME road
  // distance the delivery slab was priced from. Re-measuring, or falling back to
  // a straight line here, would let a customer be charged a hill-road fee and
  // then assessed against a crow-flies radius. Null means never measured.
  let measuredDistanceKm = null;

  if (mode === 'distance_order_value') {
    const restCoords = extractCoords(restaurant);
    const customerCoords = extractCoords(dto?.address || dto?.deliveryAddress);
    
    let distanceRule = null;
    let distanceKm = 0;
    let distanceSource = 'unknown';

    if (restCoords && customerCoords) {
      const [rLng, rLat] = restCoords;
      const [cLng, cLat] = customerCoords;
      // Road distance, not straight line. The rider follows the road, and in
      // hill terrain the two differ by a factor of two -- which put orders in
      // a cheaper slab than the trip they actually paid for.
      const measured = await resolveDeliveryDistanceKm(
        { lat: rLat, lng: rLng },
        { lat: cLat, lng: cLng },
      );
      distanceKm = measured.km;
      distanceSource = measured.source;
      measuredDistanceKm = measured.km;
      distanceRule = await resolveDistanceRule(distanceKm);
    } else {
      // Fallback: If coordinates are missing, assume base distance (0 km) to apply base delivery fee
      distanceRule = await resolveDistanceRule(0);
    }
    
    if (distanceRule) {
        const commissionRows = Array.isArray(feeSettings.distanceSlabAdminDeliveryCommission)
          ? feeSettings.distanceSlabAdminDeliveryCommission
          : [];
        const adminCommissionRow = commissionRows.find((r) => String(r.distanceRuleId) === String(distanceRule._id));
        const minDistance = Number(distanceRule.minDistance || 0);
        const isBaseSlab = minDistance <= 0;
        const userDeliveryFee = Math.round((Number(distanceRule.userDeliveryFee || 0) * 100)) / 100;
        const perKmRate = Number(distanceRule.commissionPerKm || 0);
        const fixedPayout = Math.round((Number(distanceRule.basePayout || 0) * 100)) / 100;

        if (userDeliveryFee > 0) {
          deliveryFee = userDeliveryFee;
        } else {
          const chargeableDistanceKm = Number(distanceKm || 0);
          deliveryFee = Math.round(Math.max(0, perKmRate * chargeableDistanceKm) * 100) / 100;
        }

        adminDeliveryCommissionEnabled = adminCommissionRow?.isEnabled === true;
        adminDeliveryCommissionPercent = adminDeliveryCommissionEnabled
          ? Math.round((Number(adminCommissionRow?.adminDeliveryCommissionPercent || 0) * 100)) / 100
          : 0;
        adminDeliveryCommissionAmount = Math.round((deliveryFee * (adminDeliveryCommissionPercent / 100)) * 100) / 100;
        riderDeliveryEarningAfterAdminCommission = Math.round(Math.max(0, deliveryFee - adminDeliveryCommissionAmount) * 100) / 100;
        deliveryFeeBreakdown = {
          source: 'distance_slab',
          distanceKm: Math.round(Number(distanceKm || 0) * 100) / 100,
          // Recorded so a disputed fee can be traced to how it was measured.
          distanceSource,
          distanceRuleId: String(distanceRule._id),
          distanceRange: {
            minDistance,
            maxDistance: distanceRule.maxDistance == null ? null : Number(distanceRule.maxDistance)
          },
          orderValue: subtotal,
          appliedDeliveryFee: Number(deliveryFee || 0),
          feeComputation: isBaseSlab ? 'base_slab_commission_per_km_source' : 'commission_per_km_x_total_distance',
          userDeliveryFee,
          basePayout: fixedPayout,
          commissionPerKm: perKmRate,
          adminDeliveryCommissionPercent,
          adminDeliveryCommissionAmount,
          riderDeliveryEarningAfterAdminCommission,
          feeSource: isBaseSlab ? 'distance_base_slab' : 'distance_non_base_slab'
        };
      }
  }

  /**
   * Free-delivery dishes waive the fee, but only when the whole order is made of
   * them.
   *
   * Waiving as soon as any one such dish is present would make the flag a
   * loophole: add the cheapest free-delivery item to any basket and the delivery
   * is free on everything. Requiring all of them keeps the promise honest -- the
   * dish ships free, not everything it is ordered alongside.
   *
   * The rider is still paid: only what the customer is charged is waived, which
   * is why riderDeliveryEarningAfterAdminCommission is left untouched and the
   * platform absorbs the difference. That is also why this is admin-only.
   */
  const orderedMenuItems = Array.isArray(items) ? items : [];
  const allItemsShipFree = orderedMenuItems.length > 0
    && orderedMenuItems.every((line) => line?.freeDelivery === true);

  /*
   * Platform-funded free delivery: close enough AND spending enough.
   *
   * Evaluated before the all-items waiver below so that whichever applies, the
   * fee is waived once and the breakdown records which rule did it. Both are
   * absorbed by the platform rather than the restaurant, and neither changes
   * what the rider is paid.
   */
  if (deliveryFee > 0 && !allItemsShipFree) {
    try {
      const { qualifiesForFreeDelivery, normalizeFreeDeliveryRule } =
        await import('../../shared/freeDeliveryRule.js');
      const rule = normalizeFreeDeliveryRule(feeSettings?.freeDeliveryRule);
      if (qualifiesForFreeDelivery({ rule, distanceKm: measuredDistanceKm, subtotal })) {
        const waivedAmount = deliveryFee;
        deliveryFee = 0;
        deliveryFeeBreakdown = {
          ...(deliveryFeeBreakdown || {}),
          freeDeliveryApplied: true,
          freeDeliveryReason: 'distance_and_order_value',
          freeDeliveryRule: {
            maxDistanceKm: rule.maxDistanceKm,
            minOrderAmount: rule.minOrderAmount,
            distanceKm: measuredDistanceKm,
          },
          // Kept so the order records what would have been charged, and so
          // reconciliation can see what the platform absorbed.
          waivedDeliveryFee: waivedAmount,
          appliedDeliveryFee: 0,
        };
      }
    } catch (err) {
      // A broken rule must never block an order; the fee simply stands.
      console.error('Free delivery rule evaluation failed:', err?.message || err);
    }
  }

  if (allItemsShipFree && deliveryFee > 0) {
    const waivedAmount = deliveryFee;
    deliveryFee = 0;
    deliveryFeeBreakdown = {
      ...(deliveryFeeBreakdown || {}),
      freeDeliveryApplied: true,
      // Kept so the order records what would have been charged, and so
      // reconciliation can see what the platform absorbed.
      waivedDeliveryFee: waivedAmount,
      appliedDeliveryFee: 0,
    };
  }

  const incentiveThreshold = Math.round((Number(incentiveRule.minOrderAmount || 0) * 100)) / 100;
  deliveryPartnerIncentiveEligible =
    deliveryPartnerIncentiveEnabled &&
    Number.isFinite(subtotal) &&
    subtotal >= incentiveThreshold &&
    deliveryPartnerIncentivePercent > 0;
  deliveryPartnerIncentiveAmount = deliveryPartnerIncentiveEligible
    ? Math.round((subtotal * (deliveryPartnerIncentivePercent / 100)) * 100) / 100
    : 0;

  const gstRate = Number(feeSettings.gstRate);
  const validGstRate = (!Number.isFinite(gstRate) || gstRate < 0) ? 0 : gstRate;
  const tax = Math.round(subtotal * (validGstRate / 100));

  let discount = 0;
  let appliedCoupon = null;
  const codeRaw = dto.couponCode
    ? String(dto.couponCode).trim().toUpperCase()
    : "";

  if (codeRaw) {
    const now = new Date();
    const offer = await FoodOffer.findOne({ couponCode: codeRaw }).lean();
    if (offer) {
      const statusOk = offer.status === "active";
      const startOk = !offer.startDate || now >= new Date(offer.startDate);
      const endOk = !offer.endDate || now < new Date(offer.endDate);
      const scopeOk =
        offer.restaurantScope !== "selected" ||
        String(offer.restaurantId || "") === String(dto.restaurantId || "");
      const minOk = subtotal >= (Number(offer.minOrderValue) || 0);
      let usageOk = true;
      if (
        Number(offer.usageLimit) > 0 &&
        Number(offer.usedCount || 0) >= Number(offer.usageLimit)
      ) {
        usageOk = false;
      }

      let perUserOk = true;
      if (userId && Number(offer.perUserLimit) > 0) {
        const usage = await FoodOfferUsage.findOne({
          offerId: offer._id,
          userId,
        }).lean();
        if (usage && Number(usage.count) >= Number(offer.perUserLimit)) {
          perUserOk = false;
        }
      }

      let firstOrderOk = true;
      if (userId && offer.customerScope === "first-time") {
        const c = await FoodOrder.countDocuments({
          userId: new mongoose.Types.ObjectId(userId),
        });
        firstOrderOk = c === 0;
      }
      if (userId && offer.isFirstOrderOnly === true) {
        const c2 = await FoodOrder.countDocuments({
          userId: new mongoose.Types.ObjectId(userId),
        });
        if (c2 > 0) firstOrderOk = false;
      }

      const allowed =
        statusOk &&
        startOk &&
        endOk &&
        scopeOk &&
        minOk &&
        usageOk &&
        perUserOk &&
        firstOrderOk;

      if (allowed) {
        if (offer.discountType === "percentage") {
          const raw = subtotal * (Number(offer.discountValue) / 100);
          const capped = Number(offer.maxDiscount)
            ? Math.min(raw, Number(offer.maxDiscount))
            : raw;
          discount = Math.max(0, Math.min(subtotal, Math.floor(capped)));
        } else {
          discount = Math.max(
            0,
            Math.min(subtotal, Math.floor(Number(offer.discountValue) || 0)),
          );
        }
        appliedCoupon = { code: codeRaw, discount };
      }
    }
  }

  const zoneIdForSurge = await resolveOrderZoneId(dto, restaurant);
  let surgeAmount = 0;
  if (zoneIdForSurge) {
    const surgeConfig = await FoodDeliverySurgeZone.findOne({ zoneId: zoneIdForSurge }).lean();
    if (surgeConfig?.isEnabled) {
      surgeAmount = Math.round((Number(surgeConfig.surgeAmount || 0) * 100)) / 100;
    }
  }

  const total = Math.max(
    0,
    subtotal + packagingFee + deliveryFee + platformFee + tax + surgeAmount - discount,
  );

  return {
    /**
     * The lines this pricing was computed from, including any freebie appended
     * above. Returned rather than mutated onto the caller's dto: createOrder
     * passes a spread copy here, so a mutation would be invisible to it and the
     * reward would be priced but never saved on the order.
     */
    items,
    pricing: {
      subtotal,
      tax,
      packagingFee,
      deliveryFee,
      deliveryFeeBreakdown,
      adminDeliveryCommissionEnabled,
      adminDeliveryCommissionPercent,
      adminDeliveryCommissionAmount,
      riderDeliveryEarningAfterAdminCommission,
      deliveryPartnerIncentiveEnabled,
      deliveryPartnerIncentivePercent,
      deliveryPartnerIncentiveAmount,
      deliveryPartnerIncentiveEligible,
      platformFee,
      surgeAmount,
      discount,
      total,
      currency: "INR",
      couponCode: appliedCoupon?.code || codeRaw || null,
      appliedCoupon,
      /**
       * The spend-threshold reward, for the cart and the order summary.
       *
       * `earned` is what this order qualified for; `next` is the nearest tier it
       * has not reached, so a cart can say "add Rs.40 more for a free Gulab
       * Jamun". Both come from the same resolution the order itself uses, so the
       * cart cannot promise something the order would not give.
       */
      /**
       * Buy-one-get-one, for the cart banner and the order summary.
       *
       * DISPLAY ONLY. The saving is already out of `subtotal` above -- the free
       * units were split onto zero-priced lines before it was summed -- so it is
       * deliberately absent from the `total` arithmetic. Subtracting it there
       * would take the same discount twice.
       */
      bogo: {
        totalFreeUnits: bogo.totalFreeUnits,
        savings: bogo.savings,
        lines: bogo.lines,
        /**
         * Lines one or more units short of another free one, so the cart can say
         * "add 1 more and get it free". Same resolution the split above used, so
         * the cart cannot promise a free unit the order would not grant.
         */
        next: bogo.next,
      },
      freebie: {
        earned: freebieTier
          ? {
              minOrderValue: freebieTier.minOrderValue,
              rewardType: freebieTier.rewardType,
              name: freebieLine?.name || '',
            }
          : null,
        next: freebieNextTier
          ? {
              minOrderValue: freebieNextTier.minOrderValue,
              amountAway: freebieNextTier.amountAway,
              rewardType: freebieNextTier.rewardType,
              name: freebieNextTier.rewardName || '',
            }
          : null,
      },
    },
  };
}
