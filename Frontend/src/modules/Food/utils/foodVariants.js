const toArray = (value) => (Array.isArray(value) ? value : [])

export const normalizeFoodVariants = (value) =>
  toArray(value)
    .map((entry = {}, index) => {
      const id = String(entry?.id || entry?._id || `variant-${index}`)
      const name = String(entry?.name || "").trim()
      const price = Number(entry?.price)
      if (!name || !Number.isFinite(price) || price <= 0) return null

      return {
        id,
        _id: id,
        name,
        price,
        // Per-variant add-on pairings must survive normalisation, or the picker
        // can neither offer a variant-only add-on nor show its per-size price --
        // the customer would see the published price and be charged the pairing's.
        addonIds: toArray(entry?.addonIds).map((v) => String(v?._id ?? v?.id ?? v)).filter(Boolean),
        addons: toArray(entry?.addons)
          .map((pair) => ({
            addonId: String(pair?.addonId ?? ""),
            price: pair?.price ?? null,
          }))
          .filter((pair) => pair.addonId),
      }
    })
    .filter(Boolean)

/**
 * The variants a CUSTOMER can buy. The toggle beats the array: a dish with
 * variants switched off keeps them stored, but the app must neither show a
 * size picker nor price from them. Absent flag = legacy row = sell by
 * variants if any exist, which is what those rows always did.
 */
export const getFoodVariants = (item = {}) =>
  item?.variantsEnabled === false
    ? []
    : normalizeFoodVariants(item?.variants || item?.variations || [])

/**
 * The variants as STORED, toggle ignored -- for the seller and admin editors,
 * which must show the retained configuration behind an off switch. Using the
 * customer accessor there would hydrate an empty editor and the next save
 * would wipe what the toggle was protecting.
 */
export const getStoredFoodVariants = (item = {}) =>
  normalizeFoodVariants(item?.variants || item?.variations || [])

export const hasFoodVariants = (item = {}) => getFoodVariants(item).length > 0

export const getDefaultFoodVariant = (item = {}) => getFoodVariants(item)[0] || null

export const getFoodDisplayPrice = (item = {}) => {
  const variants = getFoodVariants(item)
  if (variants.length > 0) {
    return Math.min(...variants.map((variant) => Number(variant.price) || 0))
  }

  const price = Number(item?.price)
  return Number.isFinite(price) ? price : 0
}

export const getFoodPriceLabel = (item = {}) => {
  const price = getFoodDisplayPrice(item)
  return hasFoodVariants(item) ? `Starting from ₹${Math.round(price)}` : `₹${Math.round(price)}`
}

/**
 * Identity of one cart line.
 *
 * Add-ons are part of it: a burger with extra cheese and a plain burger are two
 * different things to make and two different prices, so they cannot share a line
 * or incrementing one would silently change the other. Ids are sorted so the same
 * selection made in a different order is still the same line.
 *
 * The third argument is optional, so callers that predate add-ons keep producing
 * exactly the ids they always did.
 */
export const buildCartLineId = (itemId, variantId = "", addonIds = []) => {
  const base = `${String(itemId || "")}::${String(variantId || "base")}`
  const ids = (Array.isArray(addonIds) ? addonIds : [addonIds])
    .map((id) => String(id || "").trim())
    .filter(Boolean)
    .sort()
  return ids.length ? `${base}::${ids.join("+")}` : base
}
