import { logger } from '../../utils/logger.js';
import { getRiderFinance } from './riderFinance.service.js';
import {
    evaluateForNewJob as decideNewJob,
    evaluateForActiveJob as decideActiveJob,
    DEFAULT_ELIGIBILITY_POLICY,
    REASONS,
} from './eligibilityRules.js';

/**
 * The gathering half of the one eligibility decision.
 *
 * `eligibilityRules` decides; this fetches what it decides on, so every vertical
 * ends up consuming the SAME verdict rather than a similar one computed from its
 * own numbers. Today food recomputes cash from orders, quick-commerce reads a
 * stored field, taxi checks a cached flag at a different moment, and service
 * provider checks nothing.
 *
 * Money comes from `getRiderFinance`, which is already the correct combined
 * answer across taxi, food and quick commerce -- it was simply never the answer
 * any dispatcher asked for. Nothing new is computed here.
 *
 * Everything is passed in where the caller already knows it (distance, zone,
 * vehicle), because the dispatchers have that in hand and a second lookup would
 * be both slower and capable of disagreeing with the candidate query that
 * produced it.
 */

/** Which capability a vertical's work requires. */
const CAPABILITY_FOR_VERTICAL = Object.freeze({
    food: 'delivery',
    quickCommerce: 'quickCommerce',
    taxi: 'taxi',
});

/**
 * Assemble the context for one partner and one job.
 *
 * @param {object} args
 * @param {string} args.vertical            'food' | 'quickCommerce' | 'taxi'
 * @param {any}    args.partnerId           a partner id OR a driver id -- riderFinance resolves either
 * @param {object} [args.partner]           the partner/driver doc, if the caller already has it
 * @param {number} [args.jobCashExposure]   cash this job would add to their float
 * @param {number} [args.distanceKm]
 * @param {number} [args.locationAgeMs]
 * @param {boolean}[args.inServiceArea]
 * @param {boolean}[args.vehicleCompatible]
 * @param {boolean}[args.combinationAllowed]
 * @param {number} [args.activeJobCount]
 * @param {number} [args.maxConcurrentJobs]
 */
export async function buildContext({
    vertical,
    partnerId,
    partner = null,
    jobCashExposure = 0,
    distanceKm = null,
    locationAgeMs = null,
    inServiceArea = undefined,
    vehicleCompatible = undefined,
    combinationAllowed = undefined,
    activeJobCount = undefined,
    maxConcurrentJobs = undefined,
} = {}) {
    const finance = await getRiderFinance(partnerId);

    /*
     * Capabilities live on the unified driver. A partner who was never linked has
     * none to read, and is treated as capable of the vertical asking -- the same
     * waiver every dispatcher already applies, and for the same reason: refusing
     * work to every un-backfilled rider would be a worse outage than the rule it
     * enforces. It disappears with the backfill, not before.
     */
    let capabilities = null;
    let partnerStatus = partner?.status || null;
    let isAvailable = partner?.availabilityStatus
        ? partner.availabilityStatus === 'online'
        : (partner?.isOnline ?? undefined);

    if (finance.driverId) {
        try {
            const { Driver } = await import('../../modules/taxi/driver/models/Driver.js');
            const driver = await Driver.findById(finance.driverId)
                .select('serviceCapabilities workMode status approve isOnline activeAssignments')
                .lean();
            if (driver) {
                capabilities = Array.isArray(driver.serviceCapabilities) ? driver.serviceCapabilities : [];
                if (!partnerStatus) {
                    partnerStatus = driver.approve === false ? 'pending' : (driver.status || 'approved');
                }
                if (isAvailable === undefined) isAvailable = driver.isOnline;
                if (activeJobCount === undefined) {
                    activeJobCount = Array.isArray(driver.activeAssignments) ? driver.activeAssignments.length : 0;
                }
            }
        } catch (err) {
            // A failed capability read must not silently approve. Left null, which
            // the rules module reads as "not asserted" -- the caller decides.
            logger.warn(`eligibility: capability lookup failed for ${finance.driverId}: ${err.message}`);
        }
    }

    return {
        requiredCapability: capabilities ? CAPABILITY_FOR_VERTICAL[vertical] : null,
        capabilities: capabilities || [],
        isAvailable,
        partnerStatus,
        kycComplete: partner?.kycComplete,
        // SIGNED, and never clamped here. riderFinance is the combined figure.
        walletBalance: finance.walletBalance,
        cashInHand: finance.cashInHand,
        jobCashExposure,
        activeJobCount,
        maxConcurrentJobs,
        combinationAllowed,
        inServiceArea,
        distanceKm,
        locationAgeMs,
        vehicleCompatible,
        verticalEnabled: true,
        // Carried through so a caller can show the operator where a figure came
        // from rather than only that the answer was "no".
        _finance: finance,
    };
}

/**
 * Build the policy for this job from the platform's settings.
 *
 * A stand-in for the configuration resolver: today the only administered cash
 * ceiling is the food one, which `riderFinance.resolveSharedCashLimit` already
 * treats as the shared figure. When the PARTNER > CITY > VERTICAL > GLOBAL
 * resolver lands, this is the single function it replaces.
 */
export async function resolvePolicy(vertical, context, overrides = {}) {
    return {
        ...DEFAULT_ELIGIBILITY_POLICY,
        cashLimit: Number(context?._finance?.cashLimit) || 0,
        ...overrides,
    };
}

/**
 * May this partner be OFFERED or ASSIGNED this job? Every gate applies.
 */
export async function evaluateForNewJob(args, policyOverrides = {}) {
    const context = await buildContext(args);
    const policy = await resolvePolicy(args?.vertical, context, policyOverrides);
    const verdict = decideNewJob(context, policy);
    return { ...verdict, context, policy };
}

/**
 * May this partner FINISH the job they are already doing?
 *
 * Money is not consulted. See eligibilityRules for why: completing the job is
 * usually the thing that clears the restriction.
 */
export async function evaluateForActiveJob(args, policyOverrides = {}) {
    const context = await buildContext(args);
    const policy = await resolvePolicy(args?.vertical, context, policyOverrides);
    const verdict = decideActiveJob(context, policy);
    return { ...verdict, context, policy };
}

/**
 * The bulk form dispatchers actually need: filter a candidate list in one pass.
 *
 * Returns both the eligible ids and, for every rejection, the reasons -- so
 * "why was nobody offered this order" is answerable from a log line rather than
 * by re-running the query by hand.
 */
export async function filterEligible(candidates, args, policyOverrides = {}) {
    const eligible = [];
    const rejected = [];

    for (const candidate of candidates || []) {
        const partnerId = candidate?.partnerId || candidate?._id || candidate;
        try {
            const verdict = await evaluateForNewJob(
                { ...args, partnerId, distanceKm: candidate?.distanceKm ?? args?.distanceKm },
                policyOverrides,
            );
            if (verdict.eligible) eligible.push(candidate);
            else rejected.push({ partnerId: String(partnerId), reasons: verdict.reasons, detail: verdict.detail });
        } catch (err) {
            // A partner whose eligibility could not be determined is NOT offered
            // work. Failing open here would route around every gate in this file.
            logger.error(`eligibility: evaluation failed for ${partnerId}: ${err.message}`);
            rejected.push({ partnerId: String(partnerId), reasons: ['EVALUATION_FAILED'], detail: {} });
        }
    }

    return { eligible, rejected };
}

export { REASONS };
