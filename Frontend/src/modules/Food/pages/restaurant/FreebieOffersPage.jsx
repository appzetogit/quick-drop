import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Gift, Plus, Trash2 } from "lucide-react"
import toast from "react-hot-toast"

import { restaurantAPI } from "@food/api"
import useRestaurantBackNavigation from "@food/hooks/useRestaurantBackNavigation"

/**
 * "Spend ₹200, get a free dish."
 *
 * The reward is applied by the server from the order subtotal, so nothing here
 * decides what a customer receives -- this only configures the ladder. The same
 * document is editable from the admin panel; whichever side saves last wins.
 */

const emptyTier = () => ({
  localId: `tier-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  minOrderValue: "",
  rewardType: "item",
  rewardId: "",
})

const toTierDraft = (tier = {}) => ({
  localId: String(tier._id || `tier-${Math.random().toString(36).slice(2, 8)}`),
  minOrderValue: tier.minOrderValue != null ? String(tier.minOrderValue) : "",
  rewardType: tier.rewardType === "addon" ? "addon" : "item",
  rewardId: String(tier.rewardAddonId || tier.rewardItemId || ""),
})

export default function FreebieOffersPage() {
  const goBack = useRestaurantBackNavigation()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isActive, setIsActive] = useState(true)
  const [tiers, setTiers] = useState([])
  const [items, setItems] = useState([])
  const [addons, setAddons] = useState([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [offerRes, menuRes, addonRes] = await Promise.all([
          restaurantAPI.getFreebieOffer(),
          restaurantAPI.getMenu().catch(() => null),
          restaurantAPI.getAddons().catch(() => null),
        ])
        if (cancelled) return

        const offer = offerRes?.data?.data?.offer || offerRes?.data?.offer || null
        setIsActive(offer?.isActive !== false)
        setTiers((offer?.tiers || []).map(toTierDraft))

        // The menu comes back grouped by section; the picker wants a flat list.
        const menu = menuRes?.data?.data?.menu || menuRes?.data?.menu || menuRes?.data?.data || []
        const flat = []
        const walk = (node) => {
          if (Array.isArray(node)) return node.forEach(walk)
          if (!node || typeof node !== "object") return
          if (node.name && (node.price !== undefined || node._id)) flat.push(node)
          Object.values(node).forEach((v) => {
            if (Array.isArray(v) || (v && typeof v === "object")) walk(v)
          })
        }
        walk(menu)
        const seen = new Set()
        setItems(
          flat
            .filter((f) => {
              const id = String(f._id || f.id || "")
              if (!id || seen.has(id)) return false
              seen.add(id)
              return true
            })
            .map((f) => ({ id: String(f._id || f.id), name: f.name, price: f.price })),
        )

        const addonList =
          addonRes?.data?.data?.addons || addonRes?.data?.addons || addonRes?.data?.data || []
        setAddons(
          (Array.isArray(addonList) ? addonList : []).map((a) => ({
            id: String(a._id || a.id || ""),
            name: a.name || a.published?.name || a.draft?.name || "Add-on",
          })),
        )
      } catch (error) {
        if (!cancelled) toast.error("Could not load your free-item offers")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  const rewardOptions = useMemo(() => ({ item: items, addon: addons }), [items, addons])

  const updateTier = (localId, field, value) =>
    setTiers((prev) =>
      prev.map((t) =>
        t.localId === localId
          ? {
              ...t,
              [field]: value,
              // Switching between a dish and an add-on invalidates the chosen
              // reward, so it is cleared rather than left pointing at the other list.
              ...(field === "rewardType" ? { rewardId: "" } : {}),
            }
          : t,
      ),
    )

  const handleSave = async () => {
    const cleaned = tiers.filter((t) => String(t.minOrderValue).trim() || t.rewardId)

    for (const tier of cleaned) {
      const amount = Number(tier.minOrderValue)
      if (!Number.isFinite(amount) || amount <= 0) {
        toast.error("Every tier needs an order amount greater than 0")
        return
      }
      if (!tier.rewardId) {
        toast.error(`Choose what customers get free on orders over ${amount}`)
        return
      }
    }

    const amounts = cleaned.map((t) => Number(t.minOrderValue))
    if (new Set(amounts).size !== amounts.length) {
      toast.error("Two tiers share the same order amount. Use one reward per amount.")
      return
    }

    setSaving(true)
    try {
      await restaurantAPI.updateFreebieOffer({
        isActive,
        tiers: cleaned.map((t) => ({
          minOrderValue: Number(t.minOrderValue),
          rewardType: t.rewardType,
          ...(t.rewardType === "addon" ? { rewardAddonId: t.rewardId } : { rewardItemId: t.rewardId }),
        })),
      })
      toast.success("Free-item offers saved")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save your offers")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        <button type="button" onClick={goBack} className="rounded-full p-1.5 hover:bg-gray-100" aria-label="Back">
          <ArrowLeft className="h-5 w-5 text-gray-700" />
        </button>
        <div>
          <h1 className="text-base font-semibold text-gray-900">Free item on order value</h1>
          <p className="text-xs text-gray-500">Give a dish or add-on free once an order reaches an amount.</p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4">
          <div>
            <p className="text-sm font-medium text-gray-900">Offer is {isActive ? "on" : "off"}</p>
            <p className="text-xs text-gray-500">
              Turning it off keeps your tiers, so you can switch it back on without retyping them.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            onClick={() => setIsActive((v) => !v)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              isActive ? "bg-[#EB590E]" : "bg-gray-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                isActive ? "translate-x-[22px]" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        {loading ? (
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
            Loading…
          </div>
        ) : (
          <div className="space-y-3">
            {tiers.length === 0 && (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center">
                <Gift className="mx-auto h-6 w-6 text-gray-400" />
                <p className="mt-2 text-sm font-medium text-gray-900">No free-item offers yet</p>
                <p className="mt-1 text-xs text-gray-500">
                  Add one to give customers something free when they spend enough.
                </p>
              </div>
            )}

            {tiers.map((tier) => (
              <div key={tier.localId} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-start gap-3">
                  <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-xs text-gray-600">On orders over</label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                          {"₹"}
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={tier.minOrderValue}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9.]/g, "")
                            const parts = v.split(".")
                            updateTier(
                              tier.localId,
                              "minOrderValue",
                              parts.length > 2 ? `${parts[0]}.${parts.slice(1).join("")}` : v,
                            )
                          }}
                          placeholder="200"
                          className="w-full rounded-lg border border-gray-300 bg-gray-50 py-2.5 pl-8 pr-3 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-gray-600">Give away</label>
                      <select
                        value={tier.rewardType}
                        onChange={(e) => updateTier(tier.localId, "rewardType", e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="item">A dish</option>
                        <option value="addon">An add-on</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs text-gray-600">
                        {tier.rewardType === "addon" ? "Which add-on" : "Which dish"}
                      </label>
                      <select
                        value={tier.rewardId}
                        onChange={(e) => updateTier(tier.localId, "rewardId", e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">Select…</option>
                        {(rewardOptions[tier.rewardType] || []).map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setTiers((prev) => prev.filter((t) => t.localId !== tier.localId))}
                    className="mt-6 rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-red-500"
                    aria-label="Remove tier"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={() => setTiers((prev) => [...prev, emptyTier()])}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary-orange/20 bg-primary-orange/5 px-4 py-2 text-xs font-semibold text-accent-orange/90 hover:bg-primary-orange/10"
            >
              <Plus className="h-3.5 w-3.5" />
              Add a tier
            </button>

            <p className="pt-1 text-xs text-gray-500">
              If an order clears more than one tier, the customer gets the highest one only. The free item
              is added by us at checkout and does not count towards the amount that earned it.
            </p>
          </div>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          className="w-full rounded-lg bg-[#EB590E] py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save offers"}
        </button>
      </div>
    </div>
  )
}
