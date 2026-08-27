/**
 * The struck-through "what you'd pay elsewhere" figure shown beside our price.
 *
 * Derived from the selling price by a single admin-set markup rather than typed
 * per dish. That is what makes it track a global price adjustment: raise every
 * menu price by 10% and this rises with them automatically, because it is not
 * a stored number that can fall out of step -- it is computed from the price
 * being shown at the moment it is shown.
 *
 * It is deliberately NOT the same thing as `basePrice`. basePrice is our own
 * pre-discount price and belongs to the restaurant; this is a comparison figure
 * the platform sets across the whole menu. A dish can carry both, in which case
 * the higher one is the honest thing to strike through -- see
 * resolveComparisonPrice.
 */

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toFiniteNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/** A markup beyond this is not a comparison, it is a fiction. */
export const MAX_MARKUP_PERCENT = 300;

export const DEFAULT_OTHER_PLATFORM_SETTINGS = Object.freeze({
    isEnabled: false,
    markupPercent: 0,
    label: 'Other platforms',
});

/**
 * Read the admin setting off a fee-settings document.
 *
 * Absent means off, which is what every deployment that predates this is.
 */
export function normalizeOtherPlatformSettings(source = {}) {
    const raw = source?.otherPlatformPrice || {};
    const markup = toFiniteNumber(raw.markupPercent) ?? 0;

    return {
        isEnabled: raw.isEnabled === true,
        markupPercent: Math.min(Math.max(markup, 0), MAX_MARKUP_PERCENT),
        label: String(raw.label || DEFAULT_OTHER_PLATFORM_SETTINGS.label).trim()
            || DEFAULT_OTHER_PLATFORM_SETTINGS.label,
    };
}

/** Validate what the admin form submitted. Returns undefined if it said nothing. */
export function normalizeOtherPlatformInput(body = {}) {
    if (body?.otherPlatformPrice === undefined) return undefined;

    const raw = body.otherPlatformPrice || {};
    const markup = toFiniteNumber(raw.markupPercent);

    if (raw.isEnabled === true && (markup === null || markup <= 0)) {
        throw new Error('Set a markup above 0 to show an other-platform price');
    }
    if (markup !== null && (markup < 0 || markup > MAX_MARKUP_PERCENT)) {
        throw new Error(`Markup must be between 0 and ${MAX_MARKUP_PERCENT} percent`);
    }

    return {
        otherPlatformPrice: {
            isEnabled: raw.isEnabled === true,
            markupPercent: markup === null ? 0 : round2(markup),
            label: String(raw.label || DEFAULT_OTHER_PLATFORM_SETTINGS.label).trim()
                || DEFAULT_OTHER_PLATFORM_SETTINGS.label,
        },
    };
}

/**
 * The other-platform price for one selling price.
 *
 * Null when the feature is off, the markup is zero, or the price is zero --
 * every case where there is nothing meaningful to strike through. Returning
 * null rather than the price itself keeps clients from rendering "₹40 ₹40".
 */
export function computeOtherPlatformPrice(price, settings = {}) {
    const selling = toFiniteNumber(price);
    if (selling === null || selling <= 0) return null;

    const { isEnabled, markupPercent } = normalizeOtherPlatformSettings({
        otherPlatformPrice: settings,
    });
    if (!isEnabled || markupPercent <= 0) return null;

    const marked = round2(selling * (1 + markupPercent / 100));
    return marked > selling ? marked : null;
}

/**
 * The single figure to strike through beside the selling price.
 *
 * A dish may have both its own pre-discount price and a platform-wide
 * comparison price. Showing two struck-through numbers is noise, and showing
 * the smaller one understates the saving, so the larger wins. Whichever is
 * chosen is labelled, because "₹100" struck through means something different
 * depending on whether it is our old price or someone else's.
 */
export function resolveComparisonPrice({ price, basePrice = null, otherPlatformPrice = null, label = '' } = {}) {
    const selling = toFiniteNumber(price) ?? 0;
    const own = toFiniteNumber(basePrice);
    const other = toFiniteNumber(otherPlatformPrice);

    const candidates = [];
    if (own !== null && own > selling) candidates.push({ amount: round2(own), source: 'basePrice', label: '' });
    if (other !== null && other > selling) {
        candidates.push({ amount: round2(other), source: 'otherPlatform', label: label || DEFAULT_OTHER_PLATFORM_SETTINGS.label });
    }

    if (candidates.length === 0) {
        return { strikePrice: null, strikeSource: null, strikeLabel: '', savings: 0, savingsPercent: 0 };
    }

    const best = candidates.reduce((hi, c) => (c.amount > hi.amount ? c : hi));
    const savings = round2(best.amount - selling);

    return {
        strikePrice: best.amount,
        strikeSource: best.source,
        strikeLabel: best.label,
        savings,
        savingsPercent: best.amount > 0 ? Math.round((savings / best.amount) * 100) : 0,
    };
}
