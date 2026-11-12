import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Plus, Trash2 } from "lucide-react"
import { inventoryAPI, stockAPI } from "@food/api"
import { Card, InventoryHeader, errText, money, useInventoryParams, useStores } from "./inventoryShared"

const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100
/** A bill line split into goods and GST; when the rate has GST in it, the line total is the billed amount. */
const lineAmounts = (l, ratesInclude) => {
  const g = Number(l.gstRate) || 0
  const billed = r2(Number(l.qty) * Number(l.rate))
  if (!ratesInclude) return { taxable: billed, gst: r2((billed * g) / 100), total: r2(billed + r2((billed * g) / 100)) }
  const taxable = r2(billed / (1 + g / 100))
  return { taxable, gst: r2(billed - taxable), total: billed }
}
const field = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"

/** Find a product or size of the chosen store to add to the bill. */
function ProductSearch({ storeId, onPick }) {
  const [q, setQ] = useState("")
  const [rows, setRows] = useState([])
  useEffect(() => {
    if (!storeId || q.trim().length < 2) {
      setRows([])
      return undefined
    }
    const t = setTimeout(async () => {
      try {
        const res = await stockAPI.list("admin", { restaurantId: storeId, q: q.trim(), limit: 12 })
        setRows(res?.data?.data?.rows || [])
      } catch {
        setRows([])
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q, storeId])
  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={!storeId}
        placeholder={storeId ? "Search a product to add (name, size or SKU)" : "Pick the store first"}
        aria-label="Search a product to add"
        className={field}
      />
      {rows.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg">
          {rows.map((r) => (
            <li key={`${r.itemId}|${r.variantId}`}>
              <button
                type="button"
                onClick={() => {
                  onPick(r)
                  setQ("")
                  setRows([])
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-neutral-50"
              >
                <span>
                  <span className="font-medium text-neutral-900">{r.itemName}</span>
                  {r.variantName && <span className="text-neutral-600"> · {r.variantName}</span>}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  last bought {r.purchasePrice != null ? money(r.purchasePrice) : "—"} · stock {r.stockQty ?? "not tracked"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SupplierForm({ onSaved }) {
  const [form, setForm] = useState({ name: "", phone: "", gstin: "", supplies: "" })
  const [busy, setBusy] = useState(false)
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await inventoryAPI.addSupplier(form)
      toast.success("Supplier added")
      setForm({ name: "", phone: "", gstin: "", supplies: "" })
      onSaved()
    } catch (err) {
      toast.error(errText(err, "Could not add the supplier"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} className="grid gap-2 border-t border-neutral-100 px-4 py-3">
      {[
        ["name", "Supplier name *"],
        ["phone", "Phone"],
        ["gstin", "GSTIN"],
        ["supplies", "What they supply"],
      ].map(([k, label]) => (
        <label key={k} className="text-xs font-medium text-neutral-600">
          {label}
          <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className={`${field} mt-1`} />
        </label>
      ))}
      <button type="submit" disabled={busy || !form.name.trim()} className="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">
        {busy ? "Adding" : "Add supplier"}
      </button>
    </form>
  )
}

/**
 * Record a vendor bill: the goods received, their rate and GST. Saving adds them
 * to stock and makes each rate the product's purchase price.
 */
export default function Purchases() {
  const { store: storeParam } = useInventoryParams()
  const stores = useStores()
  const [storeId, setStoreId] = useState(storeParam)
  const [suppliers, setSuppliers] = useState([])
  const [recent, setRecent] = useState([])
  const [supplierId, setSupplierId] = useState("")
  const [billNo, setBillNo] = useState("")
  const [billDate, setBillDate] = useState(today())
  const [paidVia, setPaidVia] = useState("cash")
  // Some vendors write prices with GST already in them.
  const [ratesInclude, setRatesInclude] = useState(false)
  const [lines, setLines] = useState([])
  const [saving, setSaving] = useState(false)
  const [showSupplierForm, setShowSupplierForm] = useState(false)

  useEffect(() => setStoreId(storeParam), [storeParam])

  const loadSide = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        inventoryAPI.suppliers({ restaurantId: storeId || undefined }),
        inventoryAPI.purchases({ restaurantId: storeId || undefined, limit: 15 }),
      ])
      setSuppliers(s?.data?.data || [])
      setRecent(p?.data?.data || [])
    } catch (err) {
      toast.error(errText(err, "Could not load suppliers"))
    }
  }, [storeId])
  useEffect(() => {
    loadSide()
  }, [loadSide])

  const addLine = (r) =>
    setLines((ls) => [
      ...ls,
      {
        key: `${r.itemId}|${r.variantId}|${Date.now()}`,
        itemId: r.itemId,
        variantId: r.variantId,
        label: [r.itemName, r.variantName].filter(Boolean).join(" · "),
        unit: r.variantId ? "" : r.unit,
        qty: "",
        rate: r.purchasePrice != null ? String(r.purchasePrice) : "",
        gstRate: r.gstRate != null ? String(r.gstRate) : "0",
      },
    ])
  const setLine = (key, k, v) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v } : l)))

  const totals = useMemo(() => {
    let taxable = 0
    let gst = 0
    for (const l of lines) {
      const a = lineAmounts(l, ratesInclude)
      taxable += a.taxable
      gst += a.gst
    }
    return { taxable: r2(taxable), gst: r2(gst), total: r2(taxable + gst) }
  }, [lines, ratesInclude])

  const save = async () => {
    if (!storeId) return toast.error("Pick the store the goods came into")
    if (!lines.length) return toast.error("Add at least one product")
    setSaving(true)
    try {
      const res = await inventoryAPI.addPurchase({
        restaurantId: storeId,
        supplierId: supplierId || undefined,
        billNo,
        billDate,
        paidVia,
        ratesIncludeGst: ratesInclude,
        lines: lines.map((l) => ({ itemId: l.itemId, variantId: l.variantId || undefined, qty: Number(l.qty), rate: Number(l.rate), gstRate: Number(l.gstRate) || 0 })),
      })
      toast.success(`Purchase saved: ${money(res?.data?.data?.total)} added to stock`)
      setLines([])
      setBillNo("")
      loadSide()
    } catch (err) {
      toast.error(errText(err, "Could not save the purchase"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <InventoryHeader title="Purchases and suppliers" subtitle="Enter a vendor bill as it is written. Saving adds the goods to stock at once." showSection={false} />

        <div className="flex flex-wrap items-start gap-4">
          <Card title="Record a purchase" className="flex-[999_1_640px]">
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="text-xs font-medium text-neutral-600">Store *
                  <select value={storeId} onChange={(e) => { setStoreId(e.target.value); setLines([]) }} className={`${field} mt-1`}>
                    <option value="">Pick the store</option>
                    {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium text-neutral-600">Supplier
                  <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={`${field} mt-1`}>
                    <option value="">No supplier / mandi</option>
                    {suppliers.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium text-neutral-600">Bill no.
                  <input value={billNo} onChange={(e) => setBillNo(e.target.value)} className={`${field} mt-1`} />
                </label>
                <label className="text-xs font-medium text-neutral-600">Bill date
                  <input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className={`${field} mt-1`} />
                </label>
                <label className="text-xs font-medium text-neutral-600">Paid
                  <select value={paidVia} onChange={(e) => setPaidVia(e.target.value)} className={`${field} mt-1`}>
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="bank">Bank transfer</option>
                    <option value="credit">On credit (owed)</option>
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div role="group" aria-label="How the bill writes prices" className="flex gap-1 rounded-lg bg-neutral-100 p-1 text-sm">
                  {[
                    [false, "Rates before GST"],
                    [true, "Rates include GST"],
                  ].map(([v, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={ratesInclude === v}
                      onClick={() => setRatesInclude(v)}
                      className={`rounded-md px-3 py-1.5 font-medium ${ratesInclude === v ? "bg-neutral-900 text-white" : "text-neutral-700"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-neutral-500">
                  {ratesInclude ? "₹105 at 5% is saved as ₹100 + ₹5 GST." : "₹100 at 5% becomes ₹105 with GST."}
                </p>
              </div>

              <ProductSearch storeId={storeId} onPick={addLine} />

              {lines.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wider text-neutral-500">
                        <th className="px-2 py-2 font-medium">Product and size</th>
                        <th className="px-2 py-2 text-right font-medium">Quantity</th>
                        <th className="px-2 py-2 text-right font-medium">Rate ₹ ({ratesInclude ? "with GST" : "before GST"})</th>
                        <th className="px-2 py-2 text-right font-medium">GST %</th>
                        <th className="px-2 py-2 text-right font-medium">Amount ₹</th>
                        <th className="px-2 py-2" aria-label="Remove" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {lines.map((l) => {
                        const a = lineAmounts(l, ratesInclude)
                        return (
                          <tr key={l.key}>
                            <td className="px-2 py-2 font-medium text-neutral-900">{l.label}</td>
                            <td className="px-2 py-2 text-right">
                              <span className="inline-flex items-center gap-1">
                                <input inputMode="decimal" aria-label="Quantity" value={l.qty} onChange={(e) => setLine(l.key, "qty", e.target.value)} className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-right tabular-nums" />
                                {l.unit && <span className="text-xs text-neutral-500">{l.unit}</span>}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right"><input inputMode="decimal" aria-label="Rate" value={l.rate} onChange={(e) => setLine(l.key, "rate", e.target.value)} className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-right tabular-nums" /></td>
                            <td className="px-2 py-2 text-right">
                              <select aria-label="GST" value={l.gstRate} onChange={(e) => setLine(l.key, "gstRate", e.target.value)} className="rounded-md border border-neutral-300 px-1.5 py-1">
                                {[0, 5, 12, 18, 28].map((g) => <option key={g} value={String(g)}>{g}%</option>)}
                              </select>
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              <span className="font-semibold">{money(a.total)}</span>
                              {ratesInclude && Number(l.gstRate) > 0 && <span className="block text-xs text-neutral-500">{money(a.taxable)} + {money(a.gst)} GST</span>}
                            </td>
                            <td className="px-2 py-2 text-right">
                              <button type="button" aria-label={`Remove ${l.label}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="rounded-md p-1 text-red-700 hover:bg-red-50">
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-100 pt-3">
                <p className="text-sm text-neutral-600 tabular-nums">
                  {lines.length} line{lines.length === 1 ? "" : "s"} · Goods {money(totals.taxable)} + GST {money(totals.gst)} ={" "}
                  <span className="text-lg font-semibold text-neutral-900">{money(totals.total)}</span>
                </p>
                <button type="button" disabled={saving || !lines.length} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save and add to stock
                </button>
              </div>
            </div>
          </Card>

          <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-4">
            <Card
              title="Suppliers"
              actions={
                <button type="button" onClick={() => setShowSupplierForm((v) => !v)} className="inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs font-semibold">
                  <Plus className="h-3.5 w-3.5" /> {showSupplierForm ? "Close" : "Add supplier"}
                </button>
              }
            >
              {showSupplierForm && <SupplierForm onSaved={() => { setShowSupplierForm(false); loadSide() }} />}
              <ul className="divide-y divide-neutral-100">
                {suppliers.length === 0 && <li className="px-4 py-6 text-center text-sm text-neutral-500">No suppliers yet.</li>}
                {suppliers.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-neutral-900">{s.name}</p>
                      <p className="truncate text-xs text-neutral-500">{[s.supplies, s.phone].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div className="shrink-0 text-right text-xs tabular-nums">
                      <p className="font-semibold text-neutral-900">{money(s.thisMonth)} this month</p>
                      <p className={s.onCredit > 0 ? "text-amber-800" : "text-emerald-700"}>{s.onCredit > 0 ? `${money(s.onCredit)} on credit` : "Nothing on credit"}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Recent purchases">
              <ul className="divide-y divide-neutral-100">
                {recent.length === 0 && <li className="px-4 py-6 text-center text-sm text-neutral-500">No purchases yet.</li>}
                {recent.map((p) => (
                  <li key={p.id} className="flex justify-between gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate text-neutral-700">
                      {new Date(p.billDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} · {p.supplierName || "No supplier"}
                      {p.billNo ? ` · ${p.billNo}` : ""}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{money(p.total)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
