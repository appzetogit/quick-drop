import { useRef, useState } from "react"
import { toast } from "sonner"
import { Download, FileSpreadsheet, Loader2, Plus, Upload } from "lucide-react"
import { inventoryAPI } from "@food/api"
import { Card, InventoryHeader, errText, useInventoryParams, useStores } from "./inventoryShared"
import { IMPORT_COLUMNS, downloadTemplate, readProductSheet } from "./importColumns"
import QuickAddProduct from "./QuickAddProduct"

const ACTION = {
  create: { label: "New", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  update: { label: "Update", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  same: { label: "No change", cls: "bg-neutral-100 text-neutral-600 ring-neutral-200" },
  error: { label: "Problem", cls: "bg-red-50 text-red-800 ring-red-200" },
}
const BATCH = 2000

/**
 * Products from Excel: download the template, upload a filled sheet, see what
 * each row will do, then import. Nothing is saved until "Import".
 */
export default function InventoryImport() {
  const { store: storeParam, section } = useInventoryParams()
  const stores = useStores()
  const [store, setStore] = useState(storeParam)
  const [file, setFile] = useState(null)
  const [sheet, setSheet] = useState(null) // { rows, found, unused }
  const [preview, setPreview] = useState(null) // { summary, rows }
  const [busy, setBusy] = useState("")
  const [done, setDone] = useState(null)
  const [filter, setFilter] = useState("")
  const [quickAdd, setQuickAdd] = useState(false)
  const input = useRef(null)

  // The server takes up to 2000 rows a call; send in batches and join the reports.
  const run = async (rows, dryRun) => {
    const out = { summary: { create: 0, update: 0, same: 0, error: 0 }, rows: [] }
    for (let i = 0; i < rows.length; i += BATCH) {
      const res = await inventoryAPI.importProducts({ restaurantId: store, rows: rows.slice(i, i + BATCH), dryRun })
      const d = res?.data?.data
      for (const k of Object.keys(out.summary)) out.summary[k] += d?.summary?.[k] || 0
      out.rows.push(...(d?.rows || []).map((r) => ({ ...r, row: r.row + i })))
    }
    return out
  }

  const check = async (picked = file, target = store) => {
    if (!picked) return
    if (!target) return toast.error("Pick the store first")
    setBusy("check")
    setPreview(null)
    setDone(null)
    try {
      const s = await readProductSheet(picked)
      if (!s.rows.length) throw new Error("The sheet has no product rows under the headings")
      setSheet(s)
      setPreview(await run(s.rows, true))
    } catch (err) {
      setSheet(null)
      toast.error(errText(err, "Could not read the file"))
    } finally {
      setBusy("")
    }
  }

  const apply = async () => {
    if (!sheet) return
    setBusy("apply")
    try {
      const r = await run(sheet.rows, false)
      setDone(r.summary)
      setPreview(r)
      toast.success(`Imported: ${r.summary.create} added, ${r.summary.update} updated`)
    } catch (err) {
      toast.error(errText(err, "The import stopped"))
    } finally {
      setBusy("")
    }
  }

  const pick = (f) => {
    if (!f) return
    setFile(f)
    check(f)
  }
  const rows = (preview?.rows || []).filter((r) => !filter || r.action === filter)
  const changing = (preview?.summary?.create || 0) + (preview?.summary?.update || 0)

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <InventoryHeader
          title="Import products from Excel"
          subtitle="Add new products and update prices and stock of existing ones from one sheet. Products are matched by SKU, else by name and size."
          showSection={false}
          actions={
            <button type="button" onClick={() => setQuickAdd(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white">
              <Plus className="h-4 w-4" /> Quick add one product
            </button>
          }
        />

        <Card>
          <div className="flex flex-wrap items-end gap-4 p-4">
            <label className="text-xs font-medium text-neutral-600">Store *
              <select
                value={store}
                onChange={(e) => {
                  setStore(e.target.value)
                  if (file) check(file, e.target.value)
                }}
                className="mt-1 block min-w-[220px] rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Pick the store</option>
                {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => downloadTemplate().catch(() => toast.error("Could not make the template"))} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm">
              <Download className="h-4 w-4" /> Download template
            </button>
            <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = "" }} />
            <button
              type="button"
              disabled={!store || Boolean(busy)}
              onClick={() => input.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === "check" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {file ? "Upload another file" : "Upload Excel or CSV"}
            </button>
            {file && <span className="flex items-center gap-1.5 text-sm text-neutral-600"><FileSpreadsheet className="h-4 w-4" />{file.name}</span>}
          </div>
          {sheet && (
            <div className="border-t border-neutral-100 px-4 py-3 text-xs text-neutral-600">
              Read {sheet.rows.length} rows from “{sheet.sheet}”. Columns used: {IMPORT_COLUMNS.filter((c) => sheet.found.includes(c.key)).map((c) => c.label).join(", ")}.
              {sheet.unused.length > 0 && <span className="text-amber-800"> Ignored: {sheet.unused.join(", ")}.</span>}
            </div>
          )}
        </Card>

        {preview && (
          <Card
            title={done ? "Import finished" : "Check before importing"}
            actions={
              !done && (
                <button
                  type="button"
                  disabled={!changing || Boolean(busy)}
                  onClick={apply}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy === "apply" && <Loader2 className="h-4 w-4 animate-spin" />}
                  Import {changing} product row{changing === 1 ? "" : "s"}
                </button>
              )
            }
          >
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {[["", "All", preview.rows.length], ...Object.entries(ACTION).map(([k, a]) => [k, a.label, preview.summary[k] || 0])].map(([k, label, n]) => (
                <button
                  key={label}
                  type="button"
                  aria-pressed={filter === k}
                  onClick={() => setFilter(k)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${filter === k ? "bg-neutral-900 text-white ring-neutral-900" : "bg-white text-neutral-700 ring-neutral-300"}`}
                >
                  {label} {n}
                </button>
              ))}
            </div>
            {!done && preview.summary.error > 0 && (
              <p className="px-4 pt-2 text-xs text-red-800">Rows with a problem are skipped. Fix them in the sheet and upload it again; rows already imported will show as No change.</p>
            )}
            <div className="mt-3 max-h-[60vh] overflow-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wider text-neutral-500">
                    <th className="px-4 py-2.5 font-medium">Row</th>
                    <th className="px-4 py-2.5 font-medium">Product</th>
                    <th className="px-4 py-2.5 font-medium">Size</th>
                    <th className="px-4 py-2.5 font-medium">Result</th>
                    <th className="px-4 py-2.5 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map((r) => (
                    <tr key={r.row}>
                      <td className="px-4 py-2 tabular-nums text-neutral-500">{r.row}</td>
                      <td className="px-4 py-2 font-medium text-neutral-900">{r.name || "—"}</td>
                      <td className="px-4 py-2 text-neutral-700">{r.size || "—"}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${ACTION[r.action]?.cls}`}>{ACTION[r.action]?.label}</span>
                      </td>
                      <td className={`px-4 py-2 ${r.action === "error" ? "text-red-800" : "text-neutral-600"}`}>{r.error || r.changes.filter(Boolean).join(" · ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {!preview && (
          <Card title="How it works">
            <ol className="list-decimal space-y-1.5 py-4 pl-9 pr-4 text-sm text-neutral-700">
              <li>Download the template. It has three example rows and a sheet explaining each column. Your own Excel works too if its headings are close (Product name, MRP, Selling price, Stock…).</li>
              <li>One row per product. For a product sold in sizes, one row per size with the same product name.</li>
              <li>Upload it. You see what each row will do: add, update, or a problem to fix. Nothing changes yet.</li>
              <li>Press Import. Stock set here shows in the stock history as “Sheet upload”.</li>
            </ol>
          </Card>
        )}
      </div>
      <QuickAddProduct open={quickAdd} onClose={() => setQuickAdd(false)} storeId={store} section={section} />
    </div>
  )
}
