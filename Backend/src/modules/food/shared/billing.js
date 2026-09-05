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
 *     Packaging charges                           15.00   the restaurant's, or the platform's
 *     Add: GST @ 5%                               10.75   on the food and the packaging
 *     Delivery fee                                25.00   goes to the rider, untaxed
 *     Surge fee                                   10.00   goes to the rider, untaxed
 *     Platform fee                                10.00
 *       Govt. fee @ 18% on the platform fee        1.80
 *     Tip                                         10.00   goes to the rider, untaxed
 *     ------------------------------------------------
 *     Total                                      272.55
 *     Round off                                  + 0.45
 *     Grand total                                273.00
 *
 * Four rules worth stating because they are all easy to get wrong:
 *
 * Everything is computed to PAISE and only the grand total is rounded to a
 * rupee. Rounding each line to a rupee as it is computed, which is what the tax
 * line used to do, makes the printed lines fail to add up to the printed total
 * -- and a bill whose own arithmetic is visibly wrong is worse than one that is
 * a paisa out.
 *
 * WHAT IS TAXED, AND AT WHAT RATE. The food and the packaging are one supply
 * and carry the food's GST rate. The platform fee is a service charge and
 * carries its own, higher rate. The delivery fee, the surge and the tip are the
 * rider's money: taxing them would charge the customer for something the
 * platform never receives, and they are not the platform's to tax.
 *
 * WHAT COMMISSION IS CHARGED ON. `commissionBase` -- the listed food, before
 * any coupon and net of any GST inside it. Not the packaging, which the
 * restaurant is reimbursed for rather than earning; not the discount, which is
 * settled separately in the payout ledger; and never the tax, which is
 * collected for the government.
 *
 * INCLUSIVE PRICES ARE A DIFFERENT SUM. Adding a tax and extracting one do not
 * give the same figure: 200 x 0.05 is 10, but 200 - 200/1.05 is 9.52. Using
 * the first for an inclusive price overstates the tax and understates what the
 * restaurant earns, on every single dish.
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
 * `discount` is applied to the food and the packaging, before tax, because that
 * is what a coupon reduces -- taxing the pre-discount amount would charge GST
 * on money nobody paid. It cannot reach the delivery fee, the surge or the tip,
 * which are the rider's.
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
    /*
     * How much of `itemAmount` is priced inclusive of GST.
     *
     * The answer belongs to the dish -- the restaurant is asked when it adds
     * one -- so a cart can hold both kinds at once and this is the part that
     * already contains its tax. Undefined means "use `pricesIncludeGst` for the
     * whole amount", which is what every caller did before dishes could differ.
     */
    gstInclusiveItemAmount = undefined,
    /*
     * Whether the packaging charge is the restaurant's own per-item charge
     * rather than the platform's flat one.
     *
     * It decides whether an inclusive restaurant's setting reaches the
     * packaging line. The restaurant typed that figure alongside its prices, so
     * "my prices include GST" covers it; a charge the admin set platform-wide
     * is not the restaurant's to declare inclusive.
     */
    packagingBelongsToRestaurant = false,
} = {}) {
    const items = nonNegative(itemAmount);
    const packaging = nonNegative(packagingFee);
    const delivery = nonNegative(deliveryFee);
    const platform = nonNegative(platformFee);
    const surge = nonNegative(surgeAmount);
    const tipAmount = normalizeTip(tip);

    // A coupon cannot take more than the food and its packaging are worth.
    const appliedDiscount = round2(Math.min(nonNegative(discount), items + packaging));

    // The coupon comes off the food first; only an unusually large one reaches
    // the packaging, and it can never make either line negative.
    const itemsAfterDiscount = round2(Math.max(0, items - appliedDiscount));
    const packagingAfterDiscount = round2(
        Math.max(0, packaging - Math.max(0, appliedDiscount - items)),
    );

    const gstFraction = rate(gstRate) / 100;
    const deTax = (gross) => round2(gross / (1 + gstFraction));
    const packagingIsInclusive = pricesIncludeGst && packagingBelongsToRestaurant;

    /*
     * The two halves of the food, and the coupon shared between them.
     *
     * A cart can hold dishes priced inclusive of GST alongside dishes priced
     * exclusive of it. The coupon is split in proportion to what each half
     * contributed, because it was earned by the order as a whole and there is
     * no principled reason it should land entirely on one tax treatment --
     * doing so would change the tax the customer pays depending on which half
     * an arbitrary rule picked.
     */
    const inclusiveItems = gstInclusiveItemAmount === undefined
        ? (pricesIncludeGst ? items : 0)
        : Math.min(nonNegative(gstInclusiveItemAmount), items);
    const exclusiveItems = round2(Math.max(0, items - inclusiveItems));

    const inclusiveShare = items > 0 ? inclusiveItems / items : 0;
    const discountOnInclusive = round2(Math.min(inclusiveItems, appliedDiscount * inclusiveShare));
    const discountOnExclusive = round2(
        Math.min(exclusiveItems, Math.min(appliedDiscount, items) - discountOnInclusive),
    );

    const inclusiveAfterDiscount = round2(Math.max(0, inclusiveItems - discountOnInclusive));
    const exclusiveAfterDiscount = round2(Math.max(0, exclusiveItems - discountOnExclusive));

    // Extracting a tax is not the same sum as adding one -- see the note above.
    // The inclusive half has it taken out; the exclusive half keeps its price
    // and the tax is added below.
    const netItemAmount = round2(deTax(inclusiveAfterDiscount) + exclusiveAfterDiscount);
    const netPackagingFee = packagingIsInclusive ? deTax(packagingAfterDiscount) : packagingAfterDiscount;

    /*
     * The same two lines before the coupon, and what the coupon actually took
     * off them.
     *
     * A bill that prints the discounted line AND the coupon deducts the same
     * money twice on screen; one that prints the full line and the full coupon
     * over-deducts, because for an inclusive menu the coupon comes off a price
     * that still had tax in it. These three figures let a summary print
     *     item - discount + tax
     * and land exactly on the total.
     */
    const netItemAmountBeforeDiscount = round2(deTax(inclusiveItems) + exclusiveItems);
    const netPackagingFeeBeforeDiscount = packagingIsInclusive ? deTax(packaging) : round2(packaging);
    const discountOnNet = round2(
        (netItemAmountBeforeDiscount + netPackagingFeeBeforeDiscount)
        - (netItemAmount + netPackagingFee),
    );

    /*
     * The tax, line by line: taken out of a line whose price already contained
     * it, added on top of one that did not. Summed once so a bill that mixes
     * the two -- an inclusive restaurant under a platform-set packaging charge
     * -- still reconciles.
     */
    const taxOnItems =
        // taken out of the prices that already contained it...
        (inclusiveAfterDiscount - deTax(inclusiveAfterDiscount))
        // ...and added to the prices that did not.
        + (exclusiveAfterDiscount * gstFraction);
    const taxOnPackaging = pricesIncludeGst && packagingBelongsToRestaurant
        ? packagingAfterDiscount - netPackagingFee
        : netPackagingFee * gstFraction;

    const taxableAmount = round2(netItemAmount + netPackagingFee);
    const gstOnItems = round2(taxOnItems + taxOnPackaging);

    const platformFeeGst = round2(platform * (rate(platformFeeGstRate) / 100));

    // What the bill shows above the tip line.
    const totalBeforeTip = round2(
        taxableAmount + gstOnItems + delivery + surge + platform + platformFeeGst,
    );
    const payableBeforeRounding = round2(totalBeforeTip + tipAmount);

    // Only the final figure is rounded, so the printed lines add up to the
    // printed total once the round-off line is read.
    const grandTotal = Math.max(0, Math.round(payableBeforeRounding));
    const roundOff = round2(grandTotal - payableBeforeRounding);

    return {
        /** The food as listed, before any coupon. */
        itemAmount: round2(items),
        /** The packaging as listed, before any coupon. */
        packagingFee: round2(packaging),
        discount: appliedDiscount,
        /**
         * True when the WHOLE food total was priced inclusive of GST. False for
         * a cart that mixes the two, which is why the figures above are the
         * ones to print and this is only good for wording.
         */
        pricesIncludeGst: items > 0 ? inclusiveItems >= items - 0.005 : pricesIncludeGst === true,
        /** How much of `itemAmount` already contained its tax. */
        gstInclusiveItemAmount: round2(inclusiveItems),
        /** What the customer sees against the food and its packaging, before tax is separated out. */
        listedFoodAmount: round2(itemsAfterDiscount + packagingAfterDiscount),
        /** The "Item amount" line: food after any coupon, net of GST. */
        netItemAmount,
        /** The "Packaging charges" line, net of GST. */
        netPackagingFee,
        /** The same two before the coupon, for a summary that shows it as its own line. */
        netItemAmountBeforeDiscount,
        netPackagingFeeBeforeDiscount,
        /** What the coupon took off those two. Never print `discount` beside them. */
        discountOnNet,
        /** Both of the above together -- the base the food GST is charged on. */
        taxableAmount,
        gstRate: rate(gstRate),
        gstOnItems,
        /**
         * What restaurant commission is charged on: the listed food, before any
         * coupon and net of any GST inside it. Equal to the food subtotal for a
         * restaurant that prices net, which is every restaurant by default.
         */
        commissionBase: netItemAmountBeforeDiscount,
        deliveryFee: round2(delivery),
        surgeAmount: round2(surge),
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
 *
 * Every line the customer is shown, summed. If this is false the bill on screen
 * contradicts the amount being charged, which is the one failure a customer
 * always notices.
 */
export function billAddsUp(bill = {}) {
    const sum = round2(
        Number(bill.netItemAmount ?? bill.taxableAmount ?? 0)
        + Number(bill.netPackagingFee || 0)
        + Number(bill.gstOnItems || 0)
        + Number(bill.deliveryFee || 0)
        + Number(bill.surgeAmount || 0)
        + Number(bill.platformFee || 0)
        + Number(bill.platformFeeGst || 0)
        + Number(bill.tip || 0)
        + Number(bill.roundOff || 0),
    );
    return Math.abs(sum - Number(bill.grandTotal || 0)) < 0.005;
}
