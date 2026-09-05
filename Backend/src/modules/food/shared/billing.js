/**
 * The customer's bill, computed in one place.
 *
 * Every figure the customer is shown, and the order in which they add up. It
 * lives here rather than inline in order-pricing.service.js so the whole bill
 * can be checked without a database, a request or a restaurant -- a change to
 * any line moves what people are charged, so it has to be provable in isolation.
 *
 * The shape of the bill:
 *
 *     Item amount                                200.00
 *     Add: GST @ 5%                               10.00   on the food only
 *     Delivery fee                                25.00   goes to the rider, untaxed
 *     Platform fee                                10.00
 *       Govt. fee @ 18% on the platform fee        1.80
 *     Tip                                         10.00   goes to the rider, untaxed
 *     ------------------------------------------------
 *     Total                                      256.80
 *     Round off                                  + 0.20
 *     Grand total                                257.00
 *
 * Two rules worth stating because they are easy to get wrong:
 *
 * Everything is computed to PAISE and only the grand total is rounded to a
 * rupee. Rounding each line to a rupee as it is computed, which is what the tax
 * line used to do, makes the printed lines fail to add up to the printed total
 * -- and a bill whose own arithmetic is visibly wrong is worse than one that is
 * a paisa out.
 *
 * GST applies to the food and to the platform fee, at different rates, and to
 * nothing else. The delivery fee is the rider's money and the tip is the
 * rider's money; taxing either would be charging the customer for something the
 * platform never receives.
 */

const round2 = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
};

const nonNegative = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

const rate = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, 100);
};

/** A tip is the customer's choice, but not an unbounded one. */
export const MAX_TIP = 5000;

/** GST on a platform/service fee in India. Overridable per deployment. */
export const DEFAULT_PLATFORM_FEE_GST_RATE = 18;

export function normalizeTip(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return round2(Math.min(n, MAX_TIP));
}

/**
 * Build the bill.
 *
 * `discount` is applied to the food, before tax, because that is what a coupon
 * reduces -- taxing the pre-discount amount would charge GST on money nobody
 * paid. Surge and packaging are platform charges and sit alongside the food.
 */
export function computeBill({
    itemAmount = 0,
    packagingFee = 0,
    deliveryFee = 0,
    platformFee = 0,
    surgeAmount = 0,
    discount = 0,
    tip = 0,
    gstRate = 0,
    platformFeeGstRate = DEFAULT_PLATFORM_FEE_GST_RATE,
    /*
     * Whether the menu prices already contain GST.
     *
     * Off by default, which is what every restaurant did before this existed:
     * the stored price is net and tax is added on top, so a Rs 200 dish costs
     * the customer Rs 210. On, the Rs 200 is the whole price and the tax is
     * extracted from inside it -- Rs 190.48 of food and Rs 9.52 of tax -- so
     * the customer still pays Rs 200.
     */
    pricesIncludeGst = false,
} = {}) {
    const items = nonNegative(itemAmount);
    const packaging = nonNegative(packagingFee);
    const delivery = nonNegative(deliveryFee);
    const platform = nonNegative(platformFee);
    const surge = nonNegative(surgeAmount);
    const tipAmount = normalizeTip(tip);

    // A coupon cannot take more than the food is worth.
    const appliedDiscount = round2(Math.min(nonNegative(discount), items + packaging + surge));

    const foodAfterDiscount = round2(Math.max(0, items + packaging + surge - appliedDiscount));
    const gstFraction = rate(gstRate) / 100;

    /*
     * Extracting a tax is not the same sum as adding one. Adding: 200 x 0.05 is
     * 10. Extracting: 200 - 200/1.05 is 9.52, not 10 -- taking 5% off the
     * gross would over-report the tax and under-report the restaurant's
     * revenue on every inclusive dish.
     */
    const netFood = pricesIncludeGst
        ? round2(foodAfterDiscount / (1 + gstFraction))
        : foodAfterDiscount;
    const gstOnItems = pricesIncludeGst
        ? round2(foodAfterDiscount - netFood)
        : round2(foodAfterDiscount * gstFraction);

    // The line the bill prints as "Item amount", and the figure commission is
    // charged on: what the restaurant actually earns, never the tax inside it.
    const taxableFood = netFood;
    const platformFeeGst = round2(platform * (rate(platformFeeGstRate) / 100));

    // What the bill shows above the tip line.
    const totalBeforeTip = round2(
        taxableFood + gstOnItems + delivery + platform + platformFeeGst,
    );
    const payableBeforeRounding = round2(totalBeforeTip + tipAmount);

    // Only the final figure is rounded, so the printed lines add up to the
    // printed total once the round-off line is read.
    const grandTotal = Math.max(0, Math.round(payableBeforeRounding));
    const roundOff = round2(grandTotal - payableBeforeRounding);

    return {
        itemAmount: round2(items),
        packagingFee: round2(packaging),
        surgeAmount: round2(surge),
        discount: appliedDiscount,
        pricesIncludeGst: pricesIncludeGst === true,
        /** What the customer sees against the food, before tax is separated out. */
        listedFoodAmount: foodAfterDiscount,
        taxableAmount: taxableFood,
        gstRate: rate(gstRate),
        gstOnItems,
        deliveryFee: round2(delivery),
        platformFee: round2(platform),
        platformFeeGstRate: rate(platformFeeGstRate),
        platformFeeGst,
        tip: tipAmount,
        totalBeforeTip,
        payableBeforeRounding,
        roundOff,
        grandTotal,
    };
}

/**
 * Does the bill add up? Used by the checks, and safe to call in a test or a
 * script that wants to assert a real order rather than trust it.
 */
export function billAddsUp(bill = {}) {
    const sum = round2(
        Number(bill.taxableAmount || 0)
        + Number(bill.gstOnItems || 0)
        + Number(bill.deliveryFee || 0)
        + Number(bill.platformFee || 0)
        + Number(bill.platformFeeGst || 0)
        + Number(bill.tip || 0)
        + Number(bill.roundOff || 0),
    );
    return Math.abs(sum - Number(bill.grandTotal || 0)) < 0.005;
}
