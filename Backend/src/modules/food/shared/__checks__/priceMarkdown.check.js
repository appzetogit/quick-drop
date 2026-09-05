/**
 * Checks for the global markdown rule.
 *
 * Run: node Backend/src/modules/food/shared/__checks__/priceMarkdown.check.js
 */
import assert from 'node:assert/strict';
import { markdownFor, describeMarkdown, isMarkdownFactor, MIN_RESULT_PRICE } from '../priceMarkdown.js';

// --- isMarkdownFactor -------------------------------------------------------
assert.equal(isMarkdownFactor(0.9), true);
assert.equal(isMarkdownFactor(1), false, 'no change is not a markdown');
assert.equal(isMarkdownFactor(1.1), false, 'an increase is not a markdown');
assert.equal(isMarkdownFactor(0), false);
assert.equal(isMarkdownFactor(-0.5), false);
assert.equal(isMarkdownFactor('abc'), false);

// --- the headline case ------------------------------------------------------
// The example the behaviour was agreed on: Rs 200 selling, Rs 250 base, 20% off,
// run at -10%. The old selling price becomes the strike-through.
{
    const out = markdownFor({ price: 200, basePrice: 250, discountPercent: 20 }, 0.9);
    assert.deepEqual(out, { price: 180, basePrice: 200, discountPercent: 10 });
}

// A dish with no prior discount behaves the same way.
assert.deepEqual(
    markdownFor({ price: 100, basePrice: 100, discountPercent: 0 }, 0.75),
    { price: 75, basePrice: 100, discountPercent: 25 },
);

// The old base is deliberately discarded, not preserved as the higher strike.
{
    const out = markdownFor({ price: 200, basePrice: 400, discountPercent: 50 }, 0.9);
    assert.equal(out.basePrice, 200, 'the strike is the OLD SELLING price, not the old base');
    assert.notEqual(out.basePrice, 400);
}

// A dish whose base was already below its price (bad data) still marks down
// coherently, because the rule never reads basePrice.
assert.deepEqual(
    markdownFor({ price: 100, basePrice: 50, discountPercent: 0 }, 0.9),
    { price: 90, basePrice: 100, discountPercent: 10 },
);

// --- rounding ---------------------------------------------------------------
// Percent is derived from the rounded money, so the three fields always agree:
// basePrice x (1 - discount/100) == price.
for (const [price, factor] of [[99, 0.9], [333, 0.85], [1, 0.5], [12.5, 0.93]]) {
    const out = markdownFor({ price }, factor);
    if (!out) continue;
    const derived = Math.round(out.basePrice * (1 - out.discountPercent / 100) * 100) / 100;
    assert.ok(Math.abs(derived - out.price) < 0.02,
        `derived ${derived} should match stored ${out.price} for ${price} x ${factor}`);
}

// --- nothing sensible to do -------------------------------------------------
assert.equal(markdownFor({ price: 0 }, 0.9), null, 'an unpriced dish is left alone');
assert.equal(markdownFor({ price: -5 }, 0.9), null);
assert.equal(markdownFor({}, 0.9), null);
assert.equal(markdownFor({ price: 100 }, 1), null, 'not a reduction');
assert.equal(markdownFor({ price: 100 }, 1.2), null);

// A cut so deep the floor catches it would leave the strike at or below the
// price, which renders nothing, so the row is skipped instead.
assert.equal(markdownFor({ price: MIN_RESULT_PRICE }, 0.5), null, 'already at the floor');

// --- describeMarkdown -------------------------------------------------------
{
    const d = describeMarkdown({ price: 200, basePrice: 250 }, 0.9);
    assert.equal(d.was, 200);
    assert.equal(d.now, 180);
    assert.equal(d.saving, 20);
    assert.equal(d.percent, 10);
    // The preview names the figure being thrown away, so it is a decision
    // rather than a surprise.
    assert.equal(d.replacedBasePrice, 250);
}
assert.equal(describeMarkdown({ price: 100 }, 1.1), null);

console.log('All price markdown checks passed.');
