/**
 * Order / cart line prices with add-ons.
 *
 * Food orders keep the dish (or size) price in `price` and the add-ons apart:
 * `addons: [{ name, price, quantity }]` and `addonsTotal`, both per unit of the
 * dish. The server bills (price + addonsTotal) x quantity. Quick-commerce
 * orders already fold the add-ons into `price` and carry no `addonsTotal`, so
 * nothing is added for them, or they would be counted twice.
 */

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Add-ons on one line: [{ name, quantity, unitPrice, total }] (total is per dish). */
export function itemAddons(item) {
  const list = Array.isArray(item?.addons) ? item.addons : []
  return list
    .map((a) => {
      if (!a || typeof a !== "object") return null
      const quantity = num(a.quantity) || 1
      const unitPrice = num(a.price)
      return { name: a.name || a.title || "Add-on", quantity, unitPrice, total: unitPrice * quantity }
    })
    .filter(Boolean)
}

/** What the add-ons add to ONE dish on top of `price` (0 when already folded in). */
export function addonsPerUnit(item) {
  if (item?.addonsTotal === undefined || item?.addonsTotal === null) return 0
  return num(item.addonsTotal)
}

/** One dish including its add-ons. */
export function unitPriceWithAddons(item) {
  return num(item?.price) + addonsPerUnit(item)
}

/** The whole line: (price + add-ons) x quantity. */
export function lineTotalWithAddons(item) {
  return unitPriceWithAddons(item) * (num(item?.quantity) || 1)
}

/** "Boneless Chicken (₹50), Extra Cheese x2 (₹40)" */
export function addonsLabel(item, { withPrice = true } = {}) {
  return itemAddons(item)
    .map((a) => `${a.name}${a.quantity > 1 ? ` x${a.quantity}` : ""}${withPrice && a.total > 0 ? ` (₹${a.total % 1 ? a.total.toFixed(2) : a.total})` : ""}`)
    .join(", ")
}
