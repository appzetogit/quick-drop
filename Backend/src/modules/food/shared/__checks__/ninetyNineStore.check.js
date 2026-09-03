/**
 * Pure-logic checks for the Rs 99 auto-mark rule.
 *
 * Run: node Backend/src/modules/food/shared/__checks__/ninetyNineStore.check.js
 */
import assert from 'node:assert/strict';
import {
    NINETY_NINE_STORE_MAX_PRICE,
    isWithin99Cap,
    shouldAutoMark99,
    crossedInto99Cap,
} from '../ninetyNineStore.js';

assert.equal(NINETY_NINE_STORE_MAX_PRICE, 99);

// --- isWithin99Cap ----------------------------------------------------------
assert.equal(isWithin99Cap({ price: 99 }), true, 'exactly 99 is on the shelf');
assert.equal(isWithin99Cap({ price: 99.01 }), false, 'a paisa over is not');
assert.equal(isWithin99Cap({ price: 50 }), true);
assert.equal(isWithin99Cap({ price: 0 }), false, 'unpriced never qualifies');
assert.equal(isWithin99Cap({ price: -5 }), false);
assert.equal(isWithin99Cap({}), false);
assert.equal(isWithin99Cap({ price: 'abc' }), false);

// Variant dishes use their effective (lowest) price, as the shelf filter does.
assert.equal(isWithin99Cap({ variantsEnabled: true, variants: [{ name: 'S', price: 80 }, { name: 'L', price: 150 }] }), true);
assert.equal(isWithin99Cap({ variantsEnabled: true, variants: [{ name: 'S', price: 120 }, { name: 'L', price: 150 }] }), false);
// Variants switched off: the dish's own price decides, whatever the rows say.
assert.equal(isWithin99Cap({ variantsEnabled: false, price: 120, variants: [{ name: 'half', price: 26 }] }), false);

// --- shouldAutoMark99 --------------------------------------------------------
assert.equal(shouldAutoMark99({ approvalStatus: 'approved', price: 60 }), true);
assert.equal(shouldAutoMark99({ approvalStatus: 'approved', price: 160 }), false);
assert.equal(shouldAutoMark99({ approvalStatus: 'pending', price: 60 }), false, 'pending waits for approval');
assert.equal(shouldAutoMark99({ approvalStatus: 'rejected', price: 60 }), false, 'rejected never');
assert.equal(shouldAutoMark99({ price: 60 }), false, 'no status is not approved');

// --- crossedInto99Cap -------------------------------------------------------
// The whole point: a transition, not a state.
assert.equal(crossedInto99Cap({ price: 120 }, { price: 90 }), true, 'crossing in');
assert.equal(crossedInto99Cap({ price: 90 }, { price: 80 }), false, 'already in: no re-tick');
assert.equal(crossedInto99Cap({ price: 90 }, { price: 120 }), false, 'crossing out is not our concern');
assert.equal(crossedInto99Cap({ price: 120 }, { price: 150 }), false, 'still out');
assert.equal(crossedInto99Cap({ price: 120 }, { price: 99 }), true, 'landing exactly on the cap counts');
assert.equal(crossedInto99Cap({}, { price: 50 }), true, 'from unpriced to cheap counts');

console.log('All Rs 99 auto-mark checks passed.');
