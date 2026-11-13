import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Download, Loader2 } from "lucide-react"
import { inventoryAPI } from "@food/api"
import { Card, InventoryHeader, errText, money, qtyText, useInventoryParams } from "./inventoryShared"

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const downloadCsv = (name, rows) => {
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
const dayLabel = (key) => new Date(`${key}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric" })

/** Sales, purchases and wastage per day, stock value by category, and what was wasted. */
export default function InventoryReports() {
  const { section, store } = useInventoryParams()
  const [days, setDays] = useState(7)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await inventoryAPI.report({ section, restaurantId: store || undefined, days })
      setData(res?.data?.data || null)
    } catch (err) {
      toast.error(errText(err, "Could not load the report"))
    } finally {
      setLoading(false)
    }
  }, [section, store, days])
  useEffect(() => {
    load()
  }, [load])

  const max = Math.max(1, ...(data?.days || []).map((d) => Math.max(d.sales, d.purchases)))
  // A round top for the scale, so the gridlines read as whole amounts.
  const step = 10 ** Math.floor(Math.log10(max))
  const top = Math.ceil(max / step) * step
  const H = 180

  const exportAll = () => {
    if (!data) return
    downloadCsv(`inventory-${section}-${days}-days.csv`, [
      ["Day", "Sales", "Purchases", "Wastage"],
      ...data.days.map((d) => [d.day, d.sales, d.purchases, d.wastage]),
      [],
      ["Category", "Units", "Value at purchase price", "Value at selling price"],
      ...data.valuation.rows.map((v) => [v.category, v.units, v.cost, v.sell]),
      [],
      ["Wasted", "Quantity", "Reason", "Loss", "When", "Note"],
      ...data.wastage.map((w) => [w.name, w.qty, w.reason, w.loss, w.at, w.note]),
    ])
  }

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <InventoryHeader
          title="Inventory reports"
          subtitle="Sales at the selling price, net of cancels and returns. Purchases as billed, GST included. Wastage and stock value at purchase price."
          actions={
            <>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period" className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm">
                <option value={1}>Today</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
              <button type="button" onClick={exportAll} disabled={!data} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm disabled:opacity-40">
                <Download className="h-4 w-4" /> Download for Excel
              </button>
            </>
          }
        />

        {loading && !data ? (
          <p className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                ["Sales", data.totals.sales, "text-emerald-800"],
                ["Purchases", data.totals.purchases, "text-neutral-900"],
                ["Wastage", data.totals.wastage, "text-red-700"],
              ].map(([label, v, tone]) => (
                <div key={label} className="rounded-xl border border-neutral-200 bg-white p-4">
                  <p className="text-xs text-neutral-500">{label}</p>
                  <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{money(v)}</p>
                </div>
              ))}
            </div>

            {data.days.length > 1 && (
              <Card title="Sales and purchases per day">
                <div className="p-4">
                  <div className="mb-3 flex gap-4 text-xs text-neutral-600">
                    <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm bg-emerald-700" />Sales</span>
                    <span className="flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-3 rounded-sm bg-emerald-300" />Purchases</span>
                  </div>
                  <div className="flex gap-3" role="img" aria-label="Sales and purchases per day in rupees">
                    <div aria-hidden="true" className="flex w-14 flex-col justify-between text-right text-[11px] tabular-nums text-neutral-500" style={{ height: H }}>
                      <span>{money(top)}</span><span>{money(top / 2)}</span><span>₹0</span>
                    </div>
                    <div className="flex-1 overflow-x-auto">
                      <div className="flex items-end gap-2 border-b border-neutral-300" style={{ height: H, minWidth: data.days.length * 36 }}>
                        {data.days.map((d) => (
                          <div key={d.day} className="flex flex-1 items-end justify-center gap-0.5" style={{ height: H }}>
                            <div title={`Sales ${money(d.sales)}`} className="w-2/5 max-w-[22px] rounded-t bg-emerald-700" style={{ height: `${(d.sales / top) * H}px` }} />
                            <div title={`Purchases ${money(d.purchases)}`} className="w-2/5 max-w-[22px] rounded-t bg-emerald-300" style={{ height: `${(d.purchases / top) * H}px` }} />
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 flex gap-2" style={{ minWidth: data.days.length * 36 }}>
                        {data.days.map((d) => (
                          <span key={d.day} className="flex-1 text-center text-[11px] text-neutral-500">{dayLabel(d.day)}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            )}

            <div className="flex flex-wrap gap-4">
              <Card title="Stock value by category" className="flex-[1_1_520px]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[460px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wider text-neutral-500">
                        <th className="px-4 py-2.5 font-medium">Category</th>
                        <th className="px-4 py-2.5 text-right font-medium">Units</th>
                        <th className="px-4 py-2.5 text-right font-medium">At purchase price</th>
                        <th className="px-4 py-2.5 text-right font-medium">At selling price</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {data.valuation.rows.length === 0 && (
                        <tr><td colSpan={4} className="px-4 py-6 text-center text-neutral-500">No stock counted yet.</td></tr>
                      )}
                      {data.valuation.rows.map((v) => (
                        <tr key={v.category}>
                          <td className="px-4 py-2.5">{v.category}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{qtyText(v.units)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{money(v.cost)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{money(v.sell)}</td>
                        </tr>
                      ))}
                      <tr className="font-semibold">
                        <td className="px-4 py-2.5">Total</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{qtyText(data.valuation.total.units)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{money(data.valuation.total.cost)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{money(data.valuation.total.sell)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="px-4 pb-3 text-xs text-neutral-500">Products with no purchase price yet count at ₹0 cost until their first purchase is entered.</p>
              </Card>

              <Card title={`Wastage (${money(data.totals.wastage)})`} className="flex-[1_1_480px]">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[440px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wider text-neutral-500">
                        <th className="px-4 py-2.5 font-medium">Product</th>
                        <th className="px-4 py-2.5 font-medium">Reason</th>
                        <th className="px-4 py-2.5 text-right font-medium">Quantity</th>
                        <th className="px-4 py-2.5 text-right font-medium">Loss</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {data.wastage.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-neutral-500">Nothing wasted in this period.</td></tr>}
                      {data.wastage.map((w, i) => (
                        <tr key={i}>
                          <td className="px-4 py-2.5">{w.name}<span className="block text-xs text-neutral-500">{new Date(w.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}{w.note ? ` · ${w.note}` : ""}</span></td>
                          <td className="px-4 py-2.5 capitalize text-neutral-600">{w.reason}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{qtyText(w.qty)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-red-700">{money(w.loss)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
