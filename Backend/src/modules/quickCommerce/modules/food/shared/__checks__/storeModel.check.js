/**
 * Self-check for normal vs dark stores and the purchase-first rule.
 * Run: node src/modules/quickCommerce/modules/food/shared/__checks__/storeModel.check.js
 */
import assert from 'node:assert/strict';
import {
    applyStockedGate,
    isDarkStore,
    isVisibleToCustomers,
    normalizeStoreModelInput,
    stockedCondition,
} from '../storeModel.js';

const throws = (fn) => assert.throws(fn, (e) => e.name === 'ValidationError');
const dark = { operatingModel: 'dark_store' };
const normal = { operatingModel: 'marketplace' };

// Which stores are dark. Stores saved before the field existed are normal.
assert.equal(isDarkStore(dark), true);
assert.equal(isDarkStore(normal), false);
assert.equal(isDarkStore({}), false);
assert.equal(isDarkStore(null), false);

// A dark store shows a product only once a purchase has stocked it; a normal store always.
assert.equal(isVisibleToCustomers({}, dark), false);
assert.equal(isVisibleToCustomers({ firstStockedAt: new Date() }, dark), true);
assert.equal(isVisibleToCustomers({}, normal), true);
assert.equal(isVisibleToCustomers({}, {}), true);
assert.deepEqual(stockedCondition(dark), { firstStockedAt: { $ne: null } });
assert.deepEqual(stockedCondition(normal), {});

// Admin input: nothing sent leaves the store alone.
assert.equal(normalizeStoreModelInput({}, normal), undefined);
assert.deepEqual(normalizeStoreModelInput({ operatingModel: 'marketplace' }), { operatingModel: 'marketplace', darkStoreOwner: undefined });
// A dark store defaults to the admin as owner.
assert.deepEqual(normalizeStoreModelInput({ operatingModel: 'dark_store' }), { operatingModel: 'dark_store', darkStoreOwner: 'platform' });
assert.deepEqual(normalizeStoreModelInput({ operatingModel: 'DARK_STORE', darkStoreOwner: 'partner' }), { operatingModel: 'dark_store', darkStoreOwner: 'partner' });
// Changing only the owner keeps the stored model.
assert.deepEqual(normalizeStoreModelInput({ darkStoreOwner: 'partner' }, { operatingModel: 'dark_store', darkStoreOwner: 'platform' }), { operatingModel: 'dark_store', darkStoreOwner: 'partner' });
// Going back to normal drops the owner.
assert.deepEqual(normalizeStoreModelInput({ operatingModel: 'marketplace' }, { operatingModel: 'dark_store', darkStoreOwner: 'partner' }), { operatingModel: 'marketplace', darkStoreOwner: undefined });
// An owner on a normal store means nothing.
assert.deepEqual(normalizeStoreModelInput({ darkStoreOwner: 'partner' }, normal), { operatingModel: 'marketplace', darkStoreOwner: undefined });
throws(() => normalizeStoreModelInput({ operatingModel: 'franchise' }));
throws(() => normalizeStoreModelInput({ operatingModel: 'dark_store', darkStoreOwner: 'someone' }));

// The cross-store gate adds to $and and keeps the caller's own $or.
const ids = ['a', 'b'];
const f = applyStockedGate({ approvalStatus: 'approved', $or: [{ name: 'x' }] }, ids);
assert.deepEqual(f.$or, [{ name: 'x' }]);
assert.deepEqual(f.$and, [{ $or: [{ restaurantId: { $nin: ids } }, { firstStockedAt: { $ne: null } }] }]);
const g = applyStockedGate({ $and: [{ k: 1 }] }, ids);
assert.equal(g.$and.length, 2);
// No dark stores: the filter is untouched.
assert.deepEqual(applyStockedGate({ approvalStatus: 'approved' }, []), { approvalStatus: 'approved' });

console.log('storeModel.check: ok');
