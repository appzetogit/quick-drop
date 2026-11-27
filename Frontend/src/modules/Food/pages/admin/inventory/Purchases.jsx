import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, Package, Plus, Search, Store, Trash2, Truck, X } from "lucide-react"
import { stockAPI } from "@food/api"
import { InventoryHeader, errText, money, useInventoryParams, useInventoryScope, useStores } from "./inventoryShared"

/*
 * Purchases, laid out like a stock app: three tabs (New purchase, History,
 * Suppliers). A purchase is one vendor bill: who it came from, the items with
 * quantity, rate and GST, and how it was paid. Saving adds the goods to stock
 * and makes each rate the product's purchase price. In a dark store this is
 * also what puts a product on sale in the app.
 *
 * The store comes from the picker in the inventory header (admin) or the
 * login (store).
 */

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
const cell = "w-full rounded-md border border-neutral-300 px-2 py-1.5 text-right text-sm tabular-nums focus:border-neutral-900 focus:outline-none"
const PAID = [
  ["cash", "Cash"],
  ["upi", "UPI"],
  ["bank", "Bank"],
  ["credit", "Credit"],
]
const PAID_LABEL = Object.fromEntries(PAID)
const shortDate = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })

function Label({ children }) {
  return <span className="mb-1 block text-xs font-medium text-neutral-600">{children}</span>
}

/** Find a product or size of the chosen store to add to the bill. */
function ProductSearch({ storeId, onPick }) {
  const { stockScope } = useInventoryScope()
  const [q, setQ] = useState("")
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!storeId || q.trim().length < 2) {
      setRows([])
      return undefined
    }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await stockAPI.list(stockScope, { restaurantId: storeId, q: q.trim(), limit: 12 })
        setRows(res?.data?.data?.rows || [])
      } catch {
        setRows([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [q, storeId])
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false)
          if (e.key === "Enter" && rows.length) {
            e.preventDefault()
            onPick(rows[0])
            setQ("")
            setRows([])
          }
        }}
        placeholder="Search product to add (name, size or SKU)"
        aria-label="Search a product to add"
        className={`${field} py-2.5 pl-9`}
      />
      {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-neutral-400" />}
      {open && q.trim().length >= 2 && !loading && rows.length === 0 && (
        <p className="absolute z-20 mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-3 text-sm text-neutral-500 shadow-lg">
          No product found in this store. Add it to the store first.
        </p>
      )}
      {open && rows.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg">
          {rows.map((r) => (
            <li key={`${r.itemId}|${r.variantId}`}>
              <button
                type="button"
                // Picked on mousedown, before the search box loses focus and closes the list.
                onMouseDown={(e) => {
                  e.preventDefault()
                  onPick(r)
                  setQ("")
                  setRows([])
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-neutral-50"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-neutral-900">{r.itemName}</span>
                  {r.variantName && <span className="text-neutral-500"> · {r.variantName}</span>}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  In stock: {r.stockQty ?? "—"}
                  {r.purchasePrice != null && ` · Last rate ${money(r.purchasePrice)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SupplierForm({ onSaved, onCancel }) {
  const { api: inventoryAPI } = useInventoryScope()
  const [form, setForm] = useState({ name: "", phone: "", gstin: "", supplies: "" })
  const [busy, setBusy] = useState(false)
  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await inventoryAPI.addSupplier(form)
      toast.success("Supplier added")
      onSaved(res?.data?.data)
    } catch (err) {
      toast.error(errText(err, "Could not add the supplier"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">New supplier</h3>
        <button type="button" onClick={onCancel} aria-label="Close" className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["name", "Name *"],
          ["phone", "Phone"],
          ["gstin", "GSTIN"],
          ["supplies", "What they supply"],
        ].map(([k, label]) => (
          <label key={k}>
            <Label>{label}</Label>
            <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className={field} />
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button type="submit" disabled={busy || !form.name.trim()} className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save supplier"}
        </button>
      </div>
    </form>
  )
}

function Empty({ icon: Icon, title, text, children }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
      <Icon className="h-8 w-8 text-neutral-400" />
      <p className="text-sm font-semibold text-neutral-900">{title}</p>
      {text && <p className="max-w-sm text-sm text-neutral-500">{text}</p>}
      {children}
    </div>
  )
}

/** New purchase: bill details, items, and a sticky total bar. */
function NewPurchase({ storeId, suppliers, onSaved, onAddSupplier }) {
  const { api: inventoryAPI } = useInventoryScope()
  const [supplierId, setSupplierId] = useState("")
  const [billNo, setBillNo] = useState("")
  const [billDate, setBillDate] = useState(today())
  const [paidVia, setPaidVia] = useState("cash")
  const [ratesInclude, setRatesInclude] = useState(false)
  const [lines, setLines] = useState([])
  const [saving, setSaving] = useState(false)
  const qtyRefs = useRef({})
  // The line whose quantity box should take the cursor once it is on screen.
  const [focusKey, setFocusKey] = useState("")
  useEffect(() => {
    if (focusKey && qtyRefs.current[focusKey]) {
      qtyRefs.current[focusKey].focus()
      setFocusKey("")
    }
  }, [focusKey, lines])

  useEffect(() => setLines([]), [storeId])

  const addLine = (r) => {
    const existing = lines.find((l) => l.itemId === r.itemId && (l.variantId || "") === (r.variantId || ""))
    if (existing) {
      setFocusKey(existing.key)
      return toast.info("Already on the bill: change its quantity")
    }
    const key = `${r.itemId}|${r.variantId}|${Date.now()}`
    setLines((ls) => [
      ...ls,
      {
        key,
        itemId: r.itemId,
        variantId: r.variantId,
        name: r.itemName,
        size: r.variantName || "",
        unit: r.variantId ? "" : r.unit,
        qty: "",
        rate: r.purchasePrice != null ? String(r.purchasePrice) : "",
        gstRate: r.gstRate != null ? String(r.gstRate) : "0",
      },
    ])
    setFocusKey(key)
  }
  const setLine = (key, k, v) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [k]: v.replace(/[^\d.]/g, "") } : l)))

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

  const missing = lines.filter((l) => !(Number(l.qty) > 0) || l.rate === "").length

  const save = async () => {
    if (!lines.length) return toast.error("Add at least one product")
    if (missing) return toast.error("Fill quantity and rate for every item")
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
      toast.success(`Purchase saved · ${money(res?.data?.data?.total)} added to stock`)
      setLines([])
      setBillNo("")
      setSupplierId("")
      onSaved()
    } catch (err) {
      toast.error(errText(err, "Could not save the purchase"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Bill details */}
      <section className="rounded-xl border border-neutral-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Bill details</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label>
            <Label>Supplier</Label>
            <div className="flex gap-2">
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={field}>
                <option value="">No supplier / mandi</option>
                {suppliers.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" onClick={onAddSupplier} title="New supplier" aria-label="New supplier" className="shrink-0 rounded-lg border border-neutral-300 px-2.5 text-neutral-700 hover:bg-neutral-50">
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </label>
          <label>
            <Label>Bill no.</Label>
            <input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="Optional" className={field} />
          </label>
          <label>
            <Label>Bill date</Label>
            <input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className={field} />
          </label>
          <div>
            <Label>Payment</Label>
            <div role="group" aria-label="Payment" className="grid grid-cols-4 gap-1 rounded-lg bg-neutral-100 p-1">
              {PAID.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={paidVia === v}
                  onClick={() => setPaidVia(v)}
                  className={`rounded-md py-1.5 text-xs font-semibold ${paidVia === v ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-600"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Items */}
      <section className="rounded-xl border border-neutral-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Items {lines.length > 0 && <span className="text-neutral-500">({lines.length})</span>}</h2>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-600">
            <input type="checkbox" checked={ratesInclude} onChange={(e) => setRatesInclude(e.target.checked)} className="h-4 w-4 rounded border-neutral-300" />
            Rates on the bill include GST
          </label>
        </div>
        <div className="p-4">
          <ProductSearch storeId={storeId} onPick={addLine} />
        </div>

        {lines.length === 0 ? (
          <p className="px-4 pb-8 text-center text-sm text-neutral-500">Search above and pick products to add them to this bill.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-y border-neutral-100 bg-neutral-50 text-left text-xs text-neutral-500">
                  <th className="w-10 px-4 py-2 font-medium">#</th>
                  <th className="px-2 py-2 font-medium">Product</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Qty</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Rate ₹</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">GST</th>
                  <th className="w-28 px-2 py-2 text-right font-medium">Amount</th>
                  <th className="w-12 px-2 py-2" aria-label="Remove" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {lines.map((l, i) => {
                  const a = lineAmounts(l, ratesInclude)
                  return (
                    <tr key={l.key} className="align-middle">
                      <td className="px-4 py-2 text-neutral-400 tabular-nums">{i + 1}</td>
                      <td className="px-2 py-2">
                        <p className="font-medium text-neutral-900">{l.name}</p>
                        {(l.size || l.unit) && <p className="text-xs text-neutral-500">{l.size || `per ${l.unit}`}</p>}
                      </td>
                      <td className="px-2 py-2">
                        <input ref={(el) => { qtyRefs.current[l.key] = el }} inputMode="decimal" aria-label={`Quantity of ${l.name}`} placeholder="0" value={l.qty} onChange={(e) => setLine(l.key, "qty", e.target.value)} className={cell} />
                      </td>
                      <td className="px-2 py-2">
                        <input inputMode="decimal" aria-label={`Rate of ${l.name}`} placeholder="0" value={l.rate} onChange={(e) => setLine(l.key, "rate", e.target.value)} className={cell} />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <select aria-label={`GST of ${l.name}`} value={l.gstRate} onChange={(e) => setLine(l.key, "gstRate", e.target.value)} className="rounded-md border border-neutral-300 px-1.5 py-1.5 text-sm">
                          {[0, 5, 12, 18, 28].map((g) => <option key={g} value={String(g)}>{g}%</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums text-neutral-900">{money(a.total)}</td>
                      <td className="px-2 py-2 text-right">
                        <button type="button" aria-label={`Remove ${l.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="rounded-md p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-700">
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
      </section>

      {/* Sticky total bar */}
      <div className="sticky bottom-0 z-30 -mx-1 rounded-xl border border-neutral-200 bg-white/95 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-6 text-sm tabular-nums">
            <span className="text-neutral-500">Items <b className="text-neutral-900">{lines.length}</b></span>
            <span className="hidden text-neutral-500 sm:inline">Goods <b className="text-neutral-900">{money(totals.taxable)}</b></span>
            <span className="hidden text-neutral-500 sm:inline">GST <b className="text-neutral-900">{money(totals.gst)}</b></span>
            <span className="text-neutral-500">Total <b className="text-lg text-neutral-900">{money(totals.total)}</b></span>
          </div>
          <div className="flex items-center gap-2">
            {lines.length > 0 && (
              <button type="button" onClick={() => setLines([])} className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100">
                Clear
              </button>
            )}
            <button type="button" disabled={saving || !lines.length} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-40">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save purchase
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function History({ recent }) {
  if (!recent.length) return <Empty icon={Package} title="No purchases yet" text="Saved bills show here, newest first." />
  return (
    <section className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-neutral-100 bg-neutral-50 text-left text-xs text-neutral-500">
            <th className="px-4 py-2.5 font-medium">Date</th>
            <th className="px-2 py-2.5 font-medium">Bill no.</th>
            <th className="px-2 py-2.5 font-medium">Supplier</th>
            <th className="px-2 py-2.5 text-right font-medium">Items</th>
            <th className="px-2 py-2.5 font-medium">Payment</th>
            <th className="px-4 py-2.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {recent.map((p) => (
            <tr key={p.id} className="hover:bg-neutral-50">
              <td className="px-4 py-2.5 text-neutral-700">{shortDate(p.billDate)}</td>
              <td className="px-2 py-2.5 text-neutral-700">{p.billNo || "—"}</td>
              <td className="px-2 py-2.5 font-medium text-neutral-900">{p.supplierName || "No supplier"}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-neutral-700">{p.lines}</td>
              <td className="px-2 py-2.5">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.paidVia === "credit" ? "bg-amber-50 text-amber-800" : "bg-neutral-100 text-neutral-700"}`}>
                  {PAID_LABEL[p.paidVia] || p.paidVia}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-neutral-900">{money(p.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Suppliers({ suppliers, adding, setAdding, onSaved }) {
  return (
    <div className="space-y-4">
      {adding ? (
        <SupplierForm onSaved={onSaved} onCancel={() => setAdding(false)} />
      ) : (
        <div className="flex justify-end">
          <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white">
            <Plus className="h-4 w-4" /> Add supplier
          </button>
        </div>
      )}
      {suppliers.length === 0 ? (
        <Empty icon={Truck} title="No suppliers yet" text="Add the vendors and mandis you buy from, then pick them on a bill." />
      ) : (
        <section className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-neutral-100 bg-neutral-50 text-left text-xs text-neutral-500">
                <th className="px-4 py-2.5 font-medium">Supplier</th>
                <th className="px-2 py-2.5 font-medium">Phone</th>
                <th className="px-2 py-2.5 font-medium">Supplies</th>
                <th className="px-2 py-2.5 text-right font-medium">This month</th>
                <th className="px-4 py-2.5 text-right font-medium">On credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {suppliers.map((s) => (
                <tr key={s.id} className={s.isActive ? "" : "opacity-50"}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-neutral-900">{s.name}</p>
                    {s.gstin && <p className="text-xs text-neutral-500">GSTIN {s.gstin}</p>}
                  </td>
                  <td className="px-2 py-2.5 text-neutral-700">{s.phone || "—"}</td>
                  <td className="px-2 py-2.5 text-neutral-700">{s.supplies || "—"}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-neutral-900">{money(s.thisMonth)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${s.onCredit > 0 ? "text-amber-800" : "text-neutral-400"}`}>
                    {s.onCredit > 0 ? money(s.onCredit) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

export default function Purchases() {
  const { api: inventoryAPI, isSeller } = useInventoryScope()
  const { store: storeParam, href, path } = useInventoryParams()
  const stores = useStores()
  const navigate = useNavigate()
  const storeId = storeParam || (isSeller ? "self" : "")
  const [tab, setTab] = useState("new")
  const [suppliers, setSuppliers] = useState([])
  const [recent, setRecent] = useState([])
  const [addingSupplier, setAddingSupplier] = useState(false)

  const load = useCallback(async () => {
    if (!storeId) return
    try {
      const [s, p] = await Promise.all([
        inventoryAPI.suppliers({ restaurantId: storeId }),
        inventoryAPI.purchases({ restaurantId: storeId, limit: 50 }),
      ])
      setSuppliers(s?.data?.data || [])
      setRecent(p?.data?.data || [])
    } catch (err) {
      toast.error(errText(err, "Could not load purchases"))
    }
  }, [storeId])
  useEffect(() => {
    load()
  }, [load])

  const TABS = [
    ["new", "New purchase"],
    ["history", `History${recent.length ? ` (${recent.length})` : ""}`],
    ["suppliers", `Suppliers${suppliers.length ? ` (${suppliers.length})` : ""}`],
  ]

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <InventoryHeader title="Purchases" subtitle="Enter supplier bills. Saving adds the goods to stock." showSection={false} />

        {!storeId ? (
          <Empty icon={Store} title="Pick a store" text="Purchases are entered per store. Choose the store the goods came into.">
            <select
              aria-label="Store"
              value=""
              onChange={(e) => navigate(href(path, { store: e.target.value }))}
              className="mt-2 w-full max-w-xs rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Choose a store…</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Empty>
        ) : (
          <>
            <div role="tablist" aria-label="Purchases" className="flex gap-6 border-b border-neutral-200">
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  type="button"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 pb-2.5 text-sm font-semibold ${tab === key ? "border-neutral-900 text-neutral-900" : "border-transparent text-neutral-500 hover:text-neutral-800"}`}
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "new" && (
              <NewPurchase
                storeId={storeId}
                suppliers={suppliers}
                onSaved={load}
                onAddSupplier={() => {
                  setAddingSupplier(true)
                  setTab("suppliers")
                }}
              />
            )}
            {tab === "history" && <History recent={recent} />}
            {tab === "suppliers" && (
              <Suppliers
                suppliers={suppliers}
                adding={addingSupplier}
                setAdding={setAddingSupplier}
                onSaved={() => {
                  setAddingSupplier(false)
                  load()
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
