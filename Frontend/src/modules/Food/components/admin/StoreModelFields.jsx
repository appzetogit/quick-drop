import { Label } from "@food/components/ui/label"

/**
 * Quick commerce: is this a normal store or a Quickdrops dark store, and who runs
 * a dark store. The backend rule lives in shared/storeModel.js.
 */
export const OPERATING_MODELS = [
  { value: "marketplace", label: "Normal store" },
  { value: "dark_store", label: "Dark store" },
]

export const DARK_STORE_OWNERS = [
  { value: "platform", label: "Admin" },
  { value: "partner", label: "Partner (signs in with this store's login)" },
]

export default function StoreModelFields({ value = {}, onChange }) {
  const model = value.operatingModel || "marketplace"
  const owner = value.darkStoreOwner || "platform"
  const isDark = model === "dark_store"

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs text-gray-700 mb-1 block">Store model*</Label>
        <select
          value={model}
          onChange={(e) => onChange({
            operatingModel: e.target.value,
            darkStoreOwner: e.target.value === "dark_store" ? owner : undefined,
          })}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
        >
          {OPERATING_MODELS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-gray-500">
          {isDark
            ? "Products show in the app only after a purchase bill adds stock for them. Quickdrops bills the customer."
            : "The store adds its own products; they show in the app once approved. The store bills the customer."}
        </p>
      </div>

      {isDark && (
        <div>
          <Label className="text-xs text-gray-700 mb-1 block">Owned by*</Label>
          <select
            value={owner}
            onChange={(e) => onChange({ operatingModel: model, darkStoreOwner: e.target.value })}
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            {DARK_STORE_OWNERS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
