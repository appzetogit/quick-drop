/**
 * Every setting the platform has, declared once.
 *
 * A key/value store without this is a free-for-all: nothing stops a typo creating
 * `cash_limt`, nothing stops a cash limit being saved as the string "2000", and
 * nothing tells the admin panel what to render. The registry is what buys back the
 * schema that a generic store gives away.
 *
 * Each entry declares:
 *   type      how to coerce and validate
 *   default   the value when no level has set one -- so a missing row is never
 *             the same as zero, which is the bug in reading
 *             `Number(settings?.deliveryCashLimit) || 0` as "no limit"
 *   scopes    which levels may set it. Not everything is overridable per partner:
 *             a maintenance switch is global by nature, and offering a partner-level
 *             override for it invites someone to create one that does nothing.
 *   label/help what the panel shows
 *
 * Keys are namespaced `area.name` so the panel can group them without a second
 * table of groupings that drifts from this one.
 */

const ALL_SCOPES = ['global', 'vertical', 'zone', 'partner'];
const GLOBAL_ONLY = ['global'];
const NOT_PER_PARTNER = ['global', 'vertical', 'zone'];

export const SETTINGS = Object.freeze({
    // --- partner money -------------------------------------------------------
    'finance.cashLimit': {
        type: 'number',
        default: 0,
        min: 0,
        scopes: ALL_SCOPES,
        label: 'Cash collection limit',
        help: 'Most platform cash a partner may hold before new cash work is refused. 0 means no ceiling.',
    },
    'finance.enforceCashLimit': {
        type: 'boolean',
        default: true,
        scopes: NOT_PER_PARTNER,
        label: 'Enforce the cash limit',
        help: 'Turn off to measure the limit without acting on it.',
    },
    'finance.minimumWalletBalance': {
        type: 'number',
        default: null,
        scopes: ALL_SCOPES,
        label: 'Minimum wallet balance',
        help: 'Below this SIGNED balance a partner gets no new work. Negative is normal: taxi records cash owed as a negative balance. Unset means no minimum.',
    },
    'finance.blockOnNonPositiveWallet': {
        type: 'boolean',
        default: false,
        scopes: NOT_PER_PARTNER,
        label: 'Block at zero or below',
        help: 'Off by default. Taxi encodes cash owed as a negative balance, so switching this on platform-wide stops most riders who have collected any cash.',
    },

    // --- assignment ----------------------------------------------------------
    'assignment.maxConcurrentJobs': {
        type: 'number',
        default: 1,
        min: 1,
        max: 5,
        scopes: ALL_SCOPES,
        label: 'Maximum concurrent jobs',
        help: 'How many jobs one partner may hold at once. 1 is no stacking.',
    },
    'assignment.maxDistanceKm': {
        type: 'number',
        default: null,
        min: 1,
        scopes: NOT_PER_PARTNER,
        label: 'Assignment radius (km)',
        help: 'Unset by default, deliberately: each vertical still manages its own radius and they are not comparable. Food searches 15km from the restaurant; taxi widens through 2.5km to 15km and up to 50km intercity. A single engine-level figure of 15 would have reported every legitimate intercity ride as out of range. Set this only once the verticals hand their radius over.',
    },
    'assignment.refuseUnknownLocation': {
        type: 'boolean',
        default: false,
        scopes: NOT_PER_PARTNER,
        label: 'Refuse partners with a stale position',
        help: 'On, a partner whose last GPS fix is older than the staleness window is not offered work rather than being assumed nearby.',
    },
    'assignment.staleLocationMs': {
        type: 'number',
        default: 10 * 60 * 1000,
        min: 30_000,
        scopes: NOT_PER_PARTNER,
        label: 'Position staleness window (ms)',
    },

    // --- partner rules -------------------------------------------------------
    'partner.requireKyc': {
        type: 'boolean',
        default: false,
        scopes: NOT_PER_PARTNER,
        label: 'Require completed KYC',
    },

    // --- platform ------------------------------------------------------------
    'platform.maintenanceMode': {
        type: 'boolean',
        default: false,
        scopes: GLOBAL_ONLY,
        label: 'Maintenance mode',
        help: 'Global by nature. A per-partner maintenance override would be an override that does nothing.',
    },
});

export const isKnownKey = (key) => Object.prototype.hasOwnProperty.call(SETTINGS, key);

export const definitionOf = (key) => (isKnownKey(key) ? SETTINGS[key] : null);

/**
 * Coerce and validate a value for a key. Returns the value to store.
 * Throws with a message an operator can act on -- these surface in the panel.
 */
export function coerce(key, raw) {
    const def = definitionOf(key);
    if (!def) {
        // An unknown key is refused rather than stored. A typo that silently
        // persists is a setting somebody will later swear they changed.
        const err = new Error(`Unknown setting "${key}"`);
        err.statusCode = 400;
        throw err;
    }

    // Explicit null clears an override at this level, which is different from
    // setting it to zero. Preserved rather than coerced.
    if (raw === null || raw === undefined || raw === '') return null;

    if (def.type === 'boolean') {
        if (typeof raw === 'boolean') return raw;
        const s = String(raw).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(s)) return true;
        if (['0', 'false', 'no', 'off'].includes(s)) return false;
        const err = new Error(`"${key}" must be true or false`);
        err.statusCode = 400;
        throw err;
    }

    if (def.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
            const err = new Error(`"${key}" must be a number`);
            err.statusCode = 400;
            throw err;
        }
        if (def.min !== undefined && n < def.min) {
            const err = new Error(`"${key}" must be at least ${def.min}`);
            err.statusCode = 400;
            throw err;
        }
        if (def.max !== undefined && n > def.max) {
            const err = new Error(`"${key}" must be at most ${def.max}`);
            err.statusCode = 400;
            throw err;
        }
        return n;
    }

    return raw;
}

/**
 * May this key be set at this level?
 *
 * Refusing here rather than silently storing it is the point: a partner-level row
 * for a global-only key would sit in the database looking like an override and
 * never win anything, which is worse than an error.
 */
export function assertScopeAllowed(key, level) {
    const def = definitionOf(key);
    if (!def) {
        const err = new Error(`Unknown setting "${key}"`);
        err.statusCode = 400;
        throw err;
    }
    if (!def.scopes.includes(level)) {
        const err = new Error(
            `"${key}" cannot be set at the ${level} level. Allowed: ${def.scopes.join(', ')}`,
        );
        err.statusCode = 400;
        throw err;
    }
    return true;
}

export const defaultsFor = (keys) =>
    Object.fromEntries((keys || Object.keys(SETTINGS)).map((k) => [k, definitionOf(k)?.default]));
