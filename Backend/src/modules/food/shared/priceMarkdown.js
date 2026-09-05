/**
 * Marking a menu down so the cut is visible.
 *
 * The existing global decrease scales the base price and the selling price by
 * the same factor and holds discountPercent, so a 10% cut moves both numbers
 * and the advertised saving does not change: a dish at Rs 200 struck from
 * Rs 250 becomes Rs 180 struck from Rs 225, still "20% off". The customer
 * cannot see that anything happened.
 *
 * A markdown instead promotes today's selling price to the strike-through and
 * charges the reduced figure beneath it. Rs 200 becomes "Rs 180, was Rs 200" --
 * a 10% saving the customer can read.
 *
 * The trade this makes, stated plainly: the dish's previous pre-discount price
 * is REPLACED, not kept. A dish that was Rs 250 marked down to Rs 200 no longer
 * shows Rs 250 anywhere. That is why the caller must snapshot before applying
 * one -- an inverse multiply cannot bring back a number that was overwritten.
 * See priceAdjustment.service.js.
 */

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toPositive = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** Below this a result is treated as unpriced rather than written as zero. */
export const MIN_RESULT_PRICE = 0.01;

/**
 * A markdown only makes sense going down. A factor of 1 or more would set the
 * strike-through equal to or below what is charged, which displays nothing and
 * would quietly wipe a real pre-discount price on the way past.
 */
export const isMarkdownFactor = (factor) => {
    const f = Number(factor);
    return Number.isFinite(f) && f > 0 && f < 1;
};

/**
 * The three fields a markdown writes, for one dish.
 *
 * Returns null when there is nothing sensible to do -- an unpriced dish, or a
 * factor that is not a reduction -- so the caller can leave the row alone
 * rather than writing a zero.
 */
export function markdownFor(item = {}, factor = 1) {
    if (!isMarkdownFactor(factor)) return null;

    const current = toPositive(item?.price);
    if (current === null) return null;

    const price = Math.max(MIN_RESULT_PRICE, round2(current * factor));

    // The strike-through is what the dish sold for a moment ago. If the floor
    // above caught the price, the strike still has to sit above it or nothing
    // renders.
    const basePrice = round2(current);
    if (!(basePrice > price)) return null;

    return {
        price,
        basePrice,
        discountPercent: round2(((basePrice - price) / basePrice) * 100),
    };
}

/**
 * What a markdown would show the customer, for the admin preview.
 *
 * The preview exists because a run that worked and a run that did nothing look
 * identical afterwards, which is how the same adjustment came to be applied
 * five times in a row on this platform.
 */
export function describeMarkdown(item = {}, factor = 1) {
    const next = markdownFor(item, factor);
    if (!next) return null;
    return {
        was: next.basePrice,
        now: next.price,
        saving: round2(next.basePrice - next.price),
        percent: next.discountPercent,
        // The figure being discarded, so the admin sees what they are giving up
        // before pressing the button rather than discovering it afterwards.
        replacedBasePrice: toPositive(item?.basePrice),
    };
}
