import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, IndianRupee, Loader2, RotateCcw, TrendingDown, TrendingUp } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"

const RUPEE = "₹"

const QUICK_PERCENTS = [5, 10, 15, 20]

const formatPercent = (value) => {
  const number = Number(value) || 0
  const rounded = Math.round(number * 100) / 100
  return `${rounded > 0 ? "+" : ""}${rounded}%`
}

const formatDate = (value) => {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString()
}

export default function GlobalPricing() {
  const [restaurants, setRestaurants] = useState([])
  const [restaurantId, setRestaurantId] = useState("")
  const [direction, setDirection] = useState("increase")
  const [percent, setPercent] = useState("10")
  const [itemCount, setItemCount] = useState(null)
  const [cappedCount, setCappedCount] = useState(0)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)

  // The struck-through "elsewhere" figure. Stored as a markup over our selling
  // price rather than a number per dish, which is what makes it follow the
  // adjustment above: raise every menu price and this rises with them.
  const [otherEnabled, setOtherEnabled] = useState(false)
  const [otherMarkup, setOtherMarkup] = useState("0")
  const [otherLabel, setOtherLabel] = useState("Other platforms")
  const [savingOther, setSavingOther] = useState(false)
  const [revertingId, setRevertingId] = useState("")
  const [confirmOpen, setConfirmOpen] = useState(false)

  const signedPercent = useMemo(() => {
    const parsed = Number(percent)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return direction === "decrease" ? -parsed : parsed
  }, [percent, direction])

  const loadHistory = useCallback(async () => {
    try {
      const response = await adminAPI.getPriceAdjustments({ limit: 20 })
      setHistory(response?.data?.data?.adjustments || [])
    } catch {
      toast.error("Failed to load adjustment history")
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true)
        const response = await adminAPI.getRestaurants({ limit: 1000 })
        setRestaurants(
          response?.data?.data?.restaurants || response?.data?.restaurants || [],
        )
        await loadHistory()
      } catch {
        toast.error("Failed to load restaurants")
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [loadHistory])

  useEffect(() => {
    let cancelled = false
    const loadPreview = async () => {
      try {
        const response = await adminAPI.getPriceAdjustmentPreview({
          ...(restaurantId ? { restaurantId } : {}),
          // Sent so the preview can say how many would be held at their MRP.
          percent: Number(percent) || 0,
        })
        if (!cancelled) {
          setItemCount(response?.data?.data?.itemCount ?? null)
          setCappedCount(response?.data?.data?.itemsCappedByMrp ?? 0)
        }
      } catch {
        if (!cancelled) { setItemCount(null); setCappedCount(0) }
      }
    }
    loadPreview()
    return () => {
      cancelled = true
    }
    // percent is a dependency because the preview now reports how many items
    // that percentage would push into their MRP; without it the warning would
    // stay stale as the admin types a bigger increase.
  }, [restaurantId, percent])

  const scopeLabel = restaurantId
    ? restaurants.find((r) => String(r?._id || r?.id) === restaurantId)?.restaurantName ||
      "the selected restaurant"
    : "every restaurant"

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await adminAPI.getFeeSettings()
        const fee = res?.data?.data?.feeSettings || res?.data?.feeSettings || null
        const other = fee?.otherPlatformPrice || {}
        if (cancelled) return
        setOtherEnabled(other.isEnabled === true)
        setOtherMarkup(String(other.markupPercent ?? 0))
        setOtherLabel(String(other.label || "Other platforms"))
      } catch {
        // Leave the defaults: the section still renders and can be saved.
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSaveOther = async () => {
    const markup = Number(otherMarkup)
    if (otherEnabled && (!Number.isFinite(markup) || markup <= 0)) {
      toast.error("Set a markup above 0, or switch the comparison off")
      return
    }
    if (Number.isFinite(markup) && (markup < 0 || markup > 300)) {
      toast.error("Markup must be between 0 and 300 percent")
      return
    }

    setSavingOther(true)
    try {
      await adminAPI.createOrUpdateFeeSettings({
        otherPlatformPrice: {
          isEnabled: otherEnabled,
          markupPercent: Number.isFinite(markup) ? markup : 0,
          label: otherLabel.trim() || "Other platforms",
        },
      })
      toast.success("Comparison price saved")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not save the comparison price")
    } finally {
      setSavingOther(false)
    }
  }

  const handleApply = async () => {
    if (signedPercent === null) {
      toast.error("Enter a percent greater than 0")
      return
    }
    try {
      setApplying(true)
      const response = await adminAPI.applyPriceAdjustment({
        percent: signedPercent,
        ...(restaurantId ? { restaurantId } : {}),
      })
      const capped = response?.data?.data?.itemsCappedByMrp ?? 0
      const baseMessage = response?.data?.message || "Prices updated"
      toast.success(
        capped > 0
          ? baseMessage + " — " + capped + " held at their MRP."
          : baseMessage,
      )
      setConfirmOpen(false)
      await loadHistory()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to update prices")
    } finally {
      setApplying(false)
    }
  }

  const handleRevert = async (adjustment) => {
    const id = String(adjustment?._id || adjustment?.id || "")
    if (!id) return
    try {
      setRevertingId(id)
      const response = await adminAPI.revertPriceAdjustment(id)
      toast.success(response?.data?.message || "Adjustment reverted")
      await loadHistory()
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to revert adjustment")
    } finally {
      setRevertingId("")
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Global Price Adjustment</h1>
        <p className="mt-1 text-sm text-slate-500">
          Raise or cut every menu price at once by a percentage. The new prices apply
          everywhere immediately &mdash; menu, cart, checkout and invoices.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Apply to</label>
          <select
            value={restaurantId}
            onChange={(e) => setRestaurantId(e.target.value)}
            className="w-full md:max-w-md px-3 py-2.5 border border-slate-300 rounded-lg text-sm bg-white"
          >
            <option value="">All restaurants</option>
            {restaurants.map((restaurant) => {
              const id = String(restaurant?._id || restaurant?.id || "")
              return (
                <option key={id} value={id}>
                  {restaurant?.restaurantName || "Unnamed restaurant"}
                </option>
              )
            })}
          </select>
          {itemCount !== null && (
            <p className="mt-1 text-xs text-slate-500">
              {itemCount} food item{itemCount === 1 ? "" : "s"} will be updated.
              {cappedCount > 0 && (
                <span className="mt-1 block text-amber-700">
                  {cappedCount} of them would go above their MRP and will be held at it instead.
                </span>
              )}
            </p>
          )}
        </div>

        <div>
          <span className="block text-sm font-medium text-slate-700 mb-1">Direction</span>
          <div className="flex gap-2">
            {[
              { value: "increase", label: "Increase", Icon: TrendingUp },
              { value: "decrease", label: "Decrease", Icon: TrendingDown },
            ].map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setDirection(value)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-medium ${
                  direction === value
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Percent</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min="0"
              max="300"
              step="0.5"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              className="w-32 px-3 py-2.5 border border-slate-300 rounded-lg text-sm bg-white"
            />
            {QUICK_PERCENTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPercent(String(value))}
                className="px-3 py-1.5 rounded-full border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                {value}%
              </button>
            ))}
          </div>
        </div>

        {signedPercent !== null && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm text-slate-700">
            <span className="inline-flex items-center gap-1 font-medium">
              <IndianRupee className="h-4 w-4" />
              Example
            </span>
            <span className="ml-2">
              {RUPEE}500 becomes {RUPEE}
              {Math.max(0.01, Math.round(500 * (1 + signedPercent / 100) * 100) / 100)}
              {"  ·  "}
              {RUPEE}199 becomes {RUPEE}
              {Math.max(0.01, Math.round(199 * (1 + signedPercent / 100) * 100) / 100)}
            </span>
          </div>
        )}

        <button
          type="button"
          disabled={signedPercent === null}
          onClick={() => setConfirmOpen(true)}
          className="px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:bg-slate-300"
        >
          Apply {signedPercent !== null ? formatPercent(signedPercent) : ""} to {scopeLabel}
        </button>
      </div>

      {/* The struck-through comparison figure. A markup over our selling price
          rather than a number typed per dish, so it follows the adjustment above
          instead of going stale beside it. */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 mb-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Other platform price</h2>
            <p className="mt-1 text-xs text-slate-500 max-w-xl">
              Shows a higher price struck through next to yours in the customer app. Set as a markup on
              your selling price, so it rises and falls automatically with the adjustment above.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={otherEnabled}
            onClick={() => setOtherEnabled((v) => !v)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              otherEnabled ? "bg-slate-900" : "bg-slate-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                otherEnabled ? "translate-x-[22px]" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Markup over your price</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                max="300"
                step="1"
                value={otherMarkup}
                onChange={(e) => setOtherMarkup(e.target.value)}
                disabled={!otherEnabled}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 pr-8 text-sm disabled:bg-slate-100 disabled:text-slate-400"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">%</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Label shown to customers</label>
            <input
              type="text"
              value={otherLabel}
              onChange={(e) => setOtherLabel(e.target.value)}
              disabled={!otherEnabled}
              placeholder="Other platforms"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm disabled:bg-slate-100 disabled:text-slate-400"
            />
          </div>
        </div>

        {otherEnabled && Number(otherMarkup) > 0 && (
          <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            A {RUPEE}200 dish shows as{" "}
            <span className="line-through text-slate-400">
              {RUPEE}{Math.round(200 * (1 + Number(otherMarkup) / 100))}
            </span>{" "}
            <span className="font-semibold text-slate-900">{RUPEE}200</span>
          </div>
        )}

        <button
          type="button"
          onClick={handleSaveOther}
          disabled={savingOther}
          className="mt-4 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white disabled:bg-slate-300"
        >
          {savingOther ? "Saving…" : "Save comparison price"}
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="px-4 md:px-6 py-4 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Recent adjustments</h2>
        </div>
        {history.length === 0 ? (
          <p className="px-4 md:px-6 py-8 text-sm text-slate-500">
            No price adjustments applied yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {history.map((adjustment) => {
              const id = String(adjustment?._id || adjustment?.id || "")
              const isRevert = Boolean(adjustment?.revertsAdjustmentId)
              return (
                <li
                  key={id}
                  className="px-4 md:px-6 py-3 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="text-sm">
                    <p className="font-medium text-slate-900">
                      {formatPercent(adjustment?.percent)} &middot;{" "}
                      {adjustment?.restaurantName || "All restaurants"}
                      {isRevert && (
                        <span className="ml-2 text-xs font-normal text-slate-500">(revert)</span>
                      )}
                      {adjustment?.isReverted && (
                        <span className="ml-2 text-xs font-normal text-amber-600">reverted</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {adjustment?.itemsUpdated || 0} item(s) &middot;{" "}
                      {formatDate(adjustment?.createdAt)}
                      {adjustment?.appliedByName ? ` · ${adjustment.appliedByName}` : ""}
                    </p>
                  </div>
                  {!isRevert && !adjustment?.isReverted && (
                    <button
                      type="button"
                      onClick={() => handleRevert(adjustment)}
                      disabled={revertingId === id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 disabled:opacity-50"
                    >
                      {revertingId === id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                      Revert
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">Confirm price change</h3>
                <p className="mt-1 text-sm text-slate-600">
                  This will change the price of{" "}
                  <strong>
                    {itemCount ?? "all"} food item{itemCount === 1 ? "" : "s"}
                  </strong>{" "}
                  across <strong>{scopeLabel}</strong> by{" "}
                  <strong>{formatPercent(signedPercent)}</strong>. Customers see the new
                  prices right away. You can revert this from the history below.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={applying}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={applying}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:bg-slate-400"
              >
                {applying && <Loader2 className="h-4 w-4 animate-spin" />}
                Apply now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
