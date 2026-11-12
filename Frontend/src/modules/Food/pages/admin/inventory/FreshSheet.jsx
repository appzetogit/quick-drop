import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { inventoryAPI } from "@food/api"
import { Card, InventoryHeader, errText, money, qtyText, useInventoryParams } from "./inventoryShared"

const WASTE = [
  ["spoiled", "Spoiled"],
  ["damaged", "Damaged"],
  ["expired", "Expired"],
  ["other", "Other"],
]
const num = (v) => (v === "" || v === undefined || v === null ? null : Number(v))

/**
 * The morning sheet for fruits & vegetables: per item, what was left, what was
 * bought, sold (from orders) and wasted today, and today's price. Only the rows
 * typed into are saved. Quantities take decimals (0.25 kg = 250 g).
 */
export default function FreshSheet() {
  const { store } = useInventoryParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const [q, setQ] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await inventoryAPI.freshSheet({ restaurantId: store || undefined })
      setData(res?.data?.data || null)
      setDrafts({})
    } catch (err) {
      toast.error(errText(err, "Could not load today's sheet"))
    } finally {
      setLoading(false)
    }
  }, [store])
  useEffect(() => {
    load()
  }, [load])

  const set = (id, field, value) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), [field]: value } }))
  const rows = useMemo(() => {
    const all = data?.rows || []
    const term = q.trim().toLowerCase()
    return term ? all.filter((r) => r.name.toLowerCase().includes(term)) : all
  }, [data, q])

  const changes = Object.entries(drafts)
    .map(([itemId, d]) => {
      const row = (data?.rows || []).find((r) => r.itemId === itemId)
      if (!row) return null
      const out = { itemId }
      if (num(d.price) !== null && num(d.price) !== Number(row.price)) out.price = num(d.price)
      if (num(d.bought) > 0) {
        out.bought = num(d.bought)
        if (num(d.boughtRate) !== null) out.boughtRate = num(d.boughtRate)
      }
      if (num(d.wasted) > 0) {
        out.wasted = num(d.wasted)
        out.wasteReason = d.wasteReason || "spoiled"
      }
      if (d.selling !== undefined && d.selling !== row.selling) out.selling = d.selling
      return Object.keys(out).length > 1 ? out : null
    })
    .filter(Boolean)

  const save = async () => {
    if (!changes.length) return
    setSaving(true)
    try {
      const res = await inventoryAPI.saveFreshSheet({ rows: changes })
      const r = res?.data?.data
      if (r?.failed) toast.error(`${r.saved} saved, ${r.failed} could not be saved: ${r.results.find((x) => !x.ok)?.error || ""}`)
      else toast.success(`Saved ${r?.saved || changes.length} item${changes.length === 1 ? "" : "s"}`)
      await load()
    } catch (err) {
      toast.error(errText(err, "Could not save the sheet"))
    } finally {
      setSaving(false)
    }
  }

  const input = "w-20 rounded-md border border-neutral-300 px-2 py-1 text-right text-sm tabular-nums focus:border-neutral-900 focus:outline-none"

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <InventoryHeader
          title="Fruits & Vegetables: today's stock and prices"
          subtitle="Fill this once in the morning. Sold updates itself from orders. Remaining = left from yesterday + bought − sold − wasted. Unticking Selling hides an item at once."
          showSection={false}
          actions={
            <button
              type="button"
              disabled={!changes.length || saving}
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save {changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"}` : "today's sheet"}
            </button>
          }
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search item"
          aria-label="Search item"
          className="w-full max-w-sm rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
        />
        <Card>
          {loading ? (
            <p className="flex items-center gap-2 px-4 py-10 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading</p>
          ) : rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-neutral-600">
              No fruits or vegetables yet. Mark a product's section as <strong>Fruits &amp; Vegetables</strong> and its unit as kg in the product form, and it appears here.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wider text-neutral-500">
                    <th className="px-3 py-2.5 font-medium">Item</th>
                    <th className="px-3 py-2.5 text-right font-medium">Left from yesterday</th>
                    <th className="px-3 py-2.5 text-right font-medium">Bought today</th>
                    <th className="px-3 py-2.5 text-right font-medium">Add bought</th>
                    <th className="px-3 py-2.5 text-right font-medium">At ₹</th>
                    <th className="px-3 py-2.5 text-right font-medium">Sold</th>
                    <th className="px-3 py-2.5 text-right font-medium">Add wasted</th>
                    <th className="px-3 py-2.5 font-medium">Why</th>
                    <th className="px-3 py-2.5 text-right font-medium">Remaining</th>
                    <th className="px-3 py-2.5 text-right font-medium">Yesterday ₹</th>
                    <th className="px-3 py-2.5 text-right font-medium">Today ₹</th>
                    <th className="px-3 py-2.5 font-medium">Selling</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map((r) => {
                    const d = drafts[r.itemId] || {}
                    const selling = d.selling !== undefined ? d.selling : r.selling
                    const after = r.remaining === null ? null : (r.remaining || 0) + (num(d.bought) || 0) - (num(d.wasted) || 0)
                    const priceNow = d.price !== undefined ? d.price : r.price
                    return (
                      <tr key={r.itemId} className={!selling ? "bg-red-50/50" : d && Object.keys(d).length ? "bg-amber-50/50" : ""}>
                        <td className="px-3 py-2">
                          <p className="font-medium text-neutral-900">{r.name}</p>
                          <p className="text-xs text-neutral-500">
                            per {r.unit}
                            {r.seasonalUntil ? ` · seasonal till ${new Date(r.seasonalUntil).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}` : ""}
                            {r.sizes.length ? ` · ${r.sizes.map((s) => `${s.name} ${money(s.price)}`).join(", ")}` : ""}
                          </p>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-600">{qtyText(r.opening)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-600">{qtyText(r.bought)}</td>
                        <td className="px-3 py-2 text-right">
                          <input aria-label={`Bought ${r.name}`} inputMode="decimal" className={input} value={d.bought ?? ""} placeholder="0" onChange={(e) => set(r.itemId, "bought", e.target.value)} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input aria-label={`Bought ${r.name} at`} inputMode="decimal" className={input} value={d.boughtRate ?? ""} placeholder={r.purchasePrice ?? "—"} onChange={(e) => set(r.itemId, "boughtRate", e.target.value)} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-600">{qtyText(r.sold)}</td>
                        <td className="px-3 py-2 text-right">
                          <input aria-label={`Wasted ${r.name}`} inputMode="decimal" className={input} value={d.wasted ?? ""} placeholder="0" onChange={(e) => set(r.itemId, "wasted", e.target.value)} />
                        </td>
                        <td className="px-3 py-2">
                          <select aria-label={`Why ${r.name} was wasted`} value={d.wasteReason || "spoiled"} onChange={(e) => set(r.itemId, "wasteReason", e.target.value)} className="rounded-md border border-neutral-300 px-1.5 py-1 text-sm">
                            {WASTE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </select>
                        </td>
                        <td className={`px-3 py-2 text-right font-semibold tabular-nums ${after === 0 ? "text-red-700" : "text-neutral-900"}`}>{after === null ? "Not tracked" : qtyText(after)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.previousPrice != null ? money(r.previousPrice) : "—"}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            aria-label={`Today's price for ${r.name}`}
                            inputMode="decimal"
                            className={`${input} ${String(priceNow) !== String(r.price) ? "border-amber-500" : ""}`}
                            value={priceNow ?? ""}
                            onChange={(e) => set(r.itemId, "price", e.target.value)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <label className={`inline-flex items-center gap-2 text-xs font-semibold ${selling ? "text-emerald-700" : "text-red-700"}`}>
                            <input type="checkbox" checked={selling} onChange={(e) => set(r.itemId, "selling", e.target.checked)} />
                            {selling ? "Selling" : "Out of stock"}
                          </label>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
