import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2, X } from "lucide-react"
import { adminAPI, inventoryAPI } from "@food/api"
import { errText, useStores } from "./inventoryShared"

/** Category names for the suggestions list; the server checks the name on save. */
function useCategoryNames() {
  const [names, setNames] = useState([])
  useEffect(() => {
    let live = true
    adminAPI
      .getCategories({ limit: 1000 })
      .then((res) => {
        const list = res?.data?.data?.categories || res?.data?.categories || []
        if (live) setNames([...new Set(list.filter((c) => c?.isActive !== false).map((c) => c.name).filter(Boolean))].sort())
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return names
}

const EMPTY = { name: "", category: "", section: "grocery", unit: "", price: "", mrp: "", gstRate: "", purchasePrice: "", purchaseIncludesGst: false, stock: "", lowStockAt: "", brand: "" }

/**
 * Add one product in a single short form: what a shop owner knows when a new
 * item arrives. Sizes, images and the rest stay in the full product form.
 */
export default function QuickAddProduct({ open, onClose, storeId = "", section = "grocery", onAdded }) {
  const stores = useStores()
  const categories = useCategoryNames()
  const [store, setStore] = useState(storeId)
  const [f, setF] = useState({ ...EMPTY, section, unit: section === "fresh" ? "kg" : "" })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setStore(storeId)
      setF({ ...EMPTY, section, unit: section === "fresh" ? "kg" : "" })
    }
  }, [open, storeId, section])
  if (!open) return null

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }))
  const cost = Number(f.purchasePrice) > 0
    ? f.purchaseIncludesGst ? Number(f.purchasePrice) : Number(f.purchasePrice) * (1 + (Number(f.gstRate) || 0) / 100)
    : null
  const margin = cost !== null && Number(f.price) > 0 ? Number(f.price) - cost : null

  const save = async (e) => {
    e.preventDefault()
    if (!store) return toast.error("Pick the store")
    setBusy(true)
    try {
      const row = {
        ...f,
        purchaseIncludesGst: f.purchaseIncludesGst ? "yes" : "no",
        purchaseGstRate: f.purchasePrice ? f.gstRate : "",
        section: f.section === "fresh" ? "Fruits & Vegetables" : "Grocery",
      }
      const res = await inventoryAPI.importProducts({ restaurantId: store, rows: [row], dryRun: false })
      const r = res?.data?.data?.rows?.[0]
      if (!r || r.action === "error") throw new Error(r?.error || "Could not add the product")
      toast.success(r.action === "create" ? `${f.name} added` : r.action === "update" ? `${r.name} already existed and was updated` : `${r.name} already exists with these details`)
      onAdded?.()
      onClose()
    } catch (err) {
      toast.error(errText(err, "Could not add the product"))
    } finally {
      setBusy(false)
    }
  }

  const field = "mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
  const lab = "block text-xs font-medium text-neutral-600"
  return (
    <div role="dialog" aria-modal="true" aria-label="Quick add product" className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <form onSubmit={save} className="my-8 w-full max-w-xl space-y-4 rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">Quick add product</h2>
            <p className="text-sm text-neutral-600">A product sold as one item. For sizes (500 g, 1 kg) use the full product form or the Excel import.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className={lab}>Store *
            <select value={store} onChange={(e) => setStore(e.target.value)} className={field} required>
              <option value="">Pick the store</option>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className={lab}>Section
            <select value={f.section} onChange={(e) => setF((p) => ({ ...p, section: e.target.value, unit: e.target.value === "fresh" && !p.unit ? "kg" : p.unit }))} className={field}>
              <option value="grocery">Grocery</option>
              <option value="fresh">Fruits &amp; Vegetables</option>
            </select>
          </label>
          <label className={`${lab} sm:col-span-2`}>Product name *
            <input value={f.name} onChange={set("name")} required autoFocus className={field} placeholder="Tata Salt 1 kg" />
          </label>
          <label className={lab}>Category *
            <input value={f.category} onChange={set("category")} required list="qa-categories" className={field} placeholder="Start typing" />
            <datalist id="qa-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className={lab}>Brand
            <input value={f.brand} onChange={set("brand")} className={field} />
          </label>
          <label className={lab}>Selling price ₹ *
            <input value={f.price} onChange={set("price")} required inputMode="decimal" className={field} />
          </label>
          <label className={lab}>MRP ₹
            <input value={f.mrp} onChange={set("mrp")} inputMode="decimal" className={field} placeholder="Shown struck through" />
          </label>
          <label className={lab}>GST %
            <select value={f.gstRate} onChange={set("gstRate")} className={field}>
              <option value="">Standard rate</option>
              {[0, 5, 12, 18, 28].map((g) => <option key={g} value={String(g)}>{g}%</option>)}
            </select>
          </label>
          <label className={lab}>Counted in
            <select value={f.unit} onChange={set("unit")} className={field}>
              <option value="">Pieces / packs</option>
              <option value="kg">kg</option>
              <option value="g">grams</option>
              <option value="L">litres</option>
              <option value="ml">ml</option>
              <option value="dozen">dozen</option>
            </select>
          </label>
          <label className={lab}>Purchase price ₹
            <input value={f.purchasePrice} onChange={set("purchasePrice")} inputMode="decimal" className={field} />
            <span className="mt-1 flex items-center gap-2 font-normal text-neutral-600">
              <input type="checkbox" checked={f.purchaseIncludesGst} onChange={set("purchaseIncludesGst")} /> includes GST
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={lab}>Stock now
              <input value={f.stock} onChange={set("stock")} inputMode="decimal" className={field} placeholder="No limit" />
            </label>
            <label className={lab}>Alert at
              <input value={f.lowStockAt} onChange={set("lowStockAt")} inputMode="decimal" className={field} />
            </label>
          </div>
        </div>
        {margin !== null && (
          <p className={`rounded-lg px-3 py-2 text-sm ${margin < 0 ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-900"}`}>
            Cost with GST ₹{cost.toFixed(2)} · sells at ₹{Number(f.price).toFixed(2)} · {margin < 0 ? "loss" : "margin"} ₹{Math.abs(margin).toFixed(2)} a {f.unit || "piece"}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100">Cancel</button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Add product
          </button>
        </div>
      </form>
    </div>
  )
}
