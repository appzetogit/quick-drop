/**
 * One order line with its add-ons, for invoices.
 *
 * Food orders keep the dish (or size) price in `price` and add-ons apart, in
 * `addons: [{ name, price, quantity }]` and `addonsTotal` (both per dish); the
 * order is billed (price + addonsTotal) x quantity. Quick-commerce orders have
 * the add-ons already folded into `price` and no `addonsTotal`, so nothing is
 * added for them.
 */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function orderLineWithAddons(item = {}) {
  const name = item.name || item.menuItem?.name || 'Item';
  const quantity = num(item.quantity) || 1;
  const base = num(item.price ?? item.menuItem?.price);
  const addonsPerUnit = item.addonsTotal === undefined || item.addonsTotal === null ? 0 : num(item.addonsTotal);
  const unitPrice = base + addonsPerUnit;
  const addons = (Array.isArray(item.addons) ? item.addons : [])
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const q = num(a.quantity) || 1;
      const total = num(a.price) * q;
      return `${a.name || 'Add-on'}${q > 1 ? ` x${q}` : ''}${total > 0 ? ` (₹${total % 1 ? total.toFixed(2) : total})` : ''}`;
    });
  return {
    name,
    variantName: item.variantName || '',
    quantity,
    price: unitPrice,
    total: unitPrice * quantity,
    addonsText: addons.join(', '),
  };
}

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
