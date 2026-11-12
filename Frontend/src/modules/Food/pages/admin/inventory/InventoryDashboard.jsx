import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, RefreshCw } from "lucide-react"
import { inventoryAPI } from "@food/api"
import { BASE, Card, InventoryHeader, REASON_LABEL, errText, money, qtyText, useInventoryParams } from "./inventoryShared"

const STATUS = {
  low: { label: "Low", cls: "bg-amber-50 text-amber-900 ring-amber-200" },
  out: { label: "Out of stock", cls: "bg-red-50 text-red-800 ring-red-200" },
}

/** Inventory today, per section: counts, money in and out, and what needs restocking. */
export default function InventoryDashboard() {
  const { section, store, href } = useInventoryParams()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await inventoryAPI.summary({ section, restaurantId: store || undefined })
      setData(res?.data?.data || null)
    } catch (err) {
      toast.error(errText(err, "Could not load the inventory"))
    } finally {
      setLoading(false)
    }
  }, [section, store])

  useEffect(() => {
    load()
  }, [load])

  const tiles = data
    ? [
        { label: "Products", value: data.products, note: `${data.sizes} sizes` },
        { label: "Low stock", value: data.low, note: "at or under alert level", tone: "text-amber-800" },
        { label: "Out of stock", value: data.out, note: "hidden from customers", tone: "text-red-700" },
        { label: "Purchases today", value: money(data.purchasesToday), note: `${data.purchaseEntriesToday} entries` },
        { label: "Sales today", value: money(data.salesToday), note: "net of cancels and returns" },
        { label: "Wastage today", value: money(data.wastageToday), note: "at purchase price", tone: "text-amber-800" },
        { label: "Stock value", value: money(data.stockValue), note: "at purchase price", tone: "text-emerald-800" },
      ]
    : []

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <InventoryHeader
          title={section === "fresh" ? "Fruits & Vegetables today" : "Grocery stock today"}
          subtitle="Live from orders, purchases and wastage. Every figure comes from the stock history."
          actions={
            <button type="button" onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </button>
          }
        />

        {!data && loading ? (
          <p className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
              {tiles.map((t) => (
                <div key={t.label} className="rounded-xl border border-neutral-200 bg-white p-4">
                  <p className="text-xs text-neutral-500">{t.label}</p>
                  <p className={`mt-1 text-xl font-semibold tabular-nums ${t.tone || "text-neutral-900"}`}>{t.value}</p>
                  <p className="mt-0.5 text-xs text-neutral-500">{t.note}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-4">
              <Card
                title="Needs attention"
                className="flex-[999_1_560px]"
                actions={<Link to={href(`${BASE}/stock`)} className="text-sm font-medium text-emerald-700">All products</Link>}
              >
                {data.attention.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-neutral-500">Nothing low or out of stock.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wider text-neutral-500">
                          <th className="px-4 py-2.5 font-medium">Product</th>
                          <th className="px-4 py-2.5 font-medium">Size</th>
                          <th className="px-4 py-2.5 text-right font-medium">In stock</th>
                          <th className="px-4 py-2.5 text-right font-medium">Alert at</th>
                          <th className="px-4 py-2.5 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {data.attention.map((r) => (
                          <tr key={`${r.itemId}|${r.variantId}`}>
                            <td className="px-4 py-2.5 font-medium text-neutral-900">{r.itemName}<span className="block text-xs font-normal text-neutral-500">{r.storeName}</span></td>
                            <td className="px-4 py-2.5 text-neutral-700">{r.variantName || "—"}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{qtyText(r.stockQty, r.variantId ? "" : r.unit)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-neutral-500">{qtyText(r.lowStockThreshold)}</td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${(STATUS[r.status] || STATUS.low).cls}`}>
                                {(STATUS[r.status] || STATUS.low).label}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card
                title="Latest stock moves"
                className="flex-[1_1_320px]"
                actions={<Link to={href(`${BASE}/inventory/reports`)} className="text-sm font-medium text-emerald-700">Reports</Link>}
              >
                <ul className="divide-y divide-neutral-100">
                  {data.recentMoves.length === 0 && <li className="px-4 py-8 text-center text-sm text-neutral-500">No moves yet.</li>}
                  {data.recentMoves.map((m, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-900">{m.name}</p>
                        <p className="truncate text-xs text-neutral-500">
                          {REASON_LABEL[m.reason] || m.reason}
                          {m.detail ? ` · ${m.detail}` : ""} ·{" "}
                          {new Date(m.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                        </p>
                      </div>
                      <span className={`shrink-0 text-sm font-semibold tabular-nums ${m.delta > 0 ? "text-emerald-700" : m.reason === "wastage" ? "text-red-700" : "text-neutral-900"}`}>
                        {m.delta > 0 ? "+" : "−"}{qtyText(Math.abs(m.delta))}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
