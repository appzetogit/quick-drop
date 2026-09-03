/**
 * Pure-logic checks for the platform-funded free delivery rule.
 *
 * Run: node Backend/src/modules/food/shared/__checks__/freeDeliveryRule.check.js
 */
import assert from 'node:assert/strict';
import {
    DEFAULT_FREE_DELIVERY_RULE,
    normalizeFreeDeliveryRule,
    validateFreeDeliveryRule,
    qualifiesForFreeDelivery,
    describeFreeDeliveryRule,
    describeFreeDeliveryGap,
} from '../freeDeliveryRule.js';

const rule = (over = {}) => ({ isEnabled: true, maxDistanceKm: 3, minOrderAmount: 300, ...over });

// --- normalize ---------------------------------------------------------------
assert.equal(DEFAULT_FREE_DELIVERY_RULE.isEnabled, false, 'off until an admin turns it on');
assert.deepEqual(normalizeFreeDeliveryRule(null), { isEnabled: false, maxDistanceKm: 3, minOrderAmount: 300 });
assert.equal(normalizeFreeDeliveryRule({ isEnabled: 'yes' }).isEnabled, false, 'only a real true enables it');
assert.equal(normalizeFreeDeliveryRule({ maxDistanceKm: 'abc' }).maxDistanceKm, 3, 'junk falls back');
assert.equal(normalizeFreeDeliveryRule({ maxDistanceKm: -2 }).maxDistanceKm, 3, 'negatives fall back');
assert.equal(normalizeFreeDeliveryRule({ minOrderAmount: 0 }).minOrderAmount, 0, 'zero is a real value, not junk');

// --- validate ----------------------------------------------------------------
assert.equal(validateFreeDeliveryRule(rule()).ok, true);
assert.equal(validateFreeDeliveryRule({ isEnabled: false }).ok, true, 'a rule that is off needs no numbers');
assert.equal(validateFreeDeliveryRule(rule({ maxDistanceKm: 0 })).ok, false);
assert.equal(validateFreeDeliveryRule(rule({ minOrderAmount: 0 })).ok, false);
assert.equal(validateFreeDeliveryRule(rule({ maxDistanceKm: 500 })).ok, false, 'a 500 km radius is a typo');
assert.ok(validateFreeDeliveryRule(rule({ maxDistanceKm: 0 })).reason.length > 0, 'rejections explain themselves');

// --- qualifies ---------------------------------------------------------------
const q = (over, distanceKm, subtotal) =>
    qualifiesForFreeDelivery({ rule: rule(over), distanceKm, subtotal });

assert.equal(q({}, 2, 350), true, 'near enough and spent enough');
assert.equal(q({}, 3, 300), true, 'both edges are inclusive, as the wording promises');
assert.equal(q({}, 3.01, 300), false, 'just outside the radius');
assert.equal(q({}, 3, 299.99), false, 'just short of the amount');
assert.equal(q({}, 10, 5000), false, 'a big basket does not buy a long trip');
assert.equal(q({}, 0.5, 50), false, 'a short trip does not buy a small basket');
assert.equal(q({}, 0, 300), true, 'collection from next door still qualifies');

// Distance unknown must never qualify: a geocoding failure is not a free trip.
assert.equal(q({}, null, 5000), false, 'unmeasured distance never qualifies');
assert.equal(q({}, undefined, 5000), false);
assert.equal(q({}, NaN, 5000), false);
assert.equal(q({}, -1, 5000), false, 'a nonsense distance never qualifies');

// Off means off, whatever the numbers say.
assert.equal(qualifiesForFreeDelivery({ rule: rule({ isEnabled: false }), distanceKm: 1, subtotal: 9999 }), false);
assert.equal(qualifiesForFreeDelivery({}), false, 'no rule at all is not a free delivery');
assert.equal(qualifiesForFreeDelivery({ rule: rule({ maxDistanceKm: 0 }), distanceKm: 0, subtotal: 400 }), false,
    'a zero radius cannot be satisfied by a zero distance');

// --- copy --------------------------------------------------------------------
assert.equal(describeFreeDeliveryRule({ isEnabled: false }), '', 'nothing to say when it is off');
assert.match(describeFreeDeliveryRule(rule()), /within 3 km/);
assert.match(describeFreeDeliveryRule(rule()), /300/);

// --- the nudge ---------------------------------------------------------------
{
    const gap = describeFreeDeliveryGap({ rule: rule(), distanceKm: 2, subtotal: 250 });
    assert.equal(gap.shortBy, 50, 'tells the customer exactly how much more');
    assert.equal(gap.minOrderAmount, 300);
}
assert.equal(describeFreeDeliveryGap({ rule: rule(), distanceKm: 2, subtotal: 300 }), null, 'already earned it');
assert.equal(describeFreeDeliveryGap({ rule: rule(), distanceKm: 9, subtotal: 100 }), null,
    'too far, so never nudge toward something unreachable');
assert.equal(describeFreeDeliveryGap({ rule: rule({ isEnabled: false }), distanceKm: 1, subtotal: 10 }), null);

console.log('All free delivery rule checks passed.');
