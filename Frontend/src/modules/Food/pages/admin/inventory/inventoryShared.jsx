import { useEffect, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { stockAPI } from "@food/api"

/**
 * Shared by the inventory pages (Admin > Quick Commerce > Inventory): the page
 * tabs, the Grocery / Fruits & Vegetables switch and the store picker, so every
 * page reads the same section and store from the URL.
 */

export const BASE = "/admin/quick-commerce"

export const money = (n) =>
  `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
export const qtyText = (n, unit = "") => {
  if (n === null || n === undefined) return "—"
  const v = Math.round(Number(n) * 1000) / 1000
  return unit ? `${v} ${unit}` : String(v)
}
export const errText = (err, fallback) => err?.response?.data?.message || err?.message || fallback

/** The section and store in the URL (?section=fresh&store=…), with setters that keep the rest. */
export function useInventoryParams() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const section = params.get("section") === "fresh" ? "fresh" : "grocery"
  const store = params.get("store") || ""
  const href = (path, changes = {}) => {
    const next = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    const qs = next.toString()
    return `${path}${qs ? `?${qs}` : ""}`
  }
  return { section, store, href, path: location.pathname }
}

/** Stores that sell products, for the picker. */
export function useStores() {
  const [stores, setStores] = useState([])
  useEffect(() => {
    let live = true
    stockAPI
      .list("admin", { limit: 1 })
      .then((res) => live && setStores(res?.data?.data?.stores || []))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return stores
}

const TABS = [
  { label: "Dashboard", path: `${BASE}/inventory` },
  { label: "Products & stock", path: `${BASE}/stock` },
  { label: "Fruits & Veg daily sheet", path: `${BASE}/inventory/fresh` },
  { label: "Purchases & suppliers", path: `${BASE}/inventory/purchases` },
  { label: "Import from Excel", path: `${BASE}/inventory/import` },
  { label: "Reports", path: `${BASE}/inventory/reports` },
]

export function InventoryHeader({ title, subtitle, showSection = true, actions = null }) {
  const { section, store, href, path } = useInventoryParams()
  const stores = useStores()
  const navigate = useNavigate()
  return (
    <div className="space-y-4">
      <nav aria-label="Inventory pages" className="flex gap-1 overflow-x-auto rounded-xl border border-neutral-200 bg-white p-1">
        {TABS.map((t) => (
          <Link
            key={t.path}
            to={href(t.path)}
            aria-current={path === t.path ? "page" : undefined}
            className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${path === t.path ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">{title}</h1>
          {subtitle && <p className="mt-1 max-w-2xl text-sm text-neutral-600">{subtitle}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showSection && (
            <div role="group" aria-label="Section" className="flex gap-1 rounded-xl bg-neutral-100 p-1">
              {[
                ["grocery", "Grocery"],
                ["fresh", "Fruits & Vegetables"],
              ].map(([key, label]) => (
                <Link
                  key={key}
                  to={href(path, { section: key === "grocery" ? "" : key })}
                  aria-current={section === key ? "true" : undefined}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${section === key ? "bg-neutral-900 text-white" : "text-neutral-700"}`}
                >
                  {label}
                </Link>
              ))}
            </div>
          )}
          <StorePicker stores={stores} value={store} onPick={(id) => navigate(href(path, { store: id }))} />
          {actions}
        </div>
      </div>
    </div>
  )
}

function StorePicker({ stores, value, onPick }) {
  return (
    <select
      aria-label="Store"
      value={value}
      onChange={(e) => onPick(e.target.value)}
      className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
    >
      <option value="">All stores</option>
      {stores.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  )
}

export function Card({ title, children, className = "", actions = null }) {
  return (
    <section className={`min-w-0 rounded-xl border border-neutral-200 bg-white ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export const REASON_LABEL = {
  sale: "Sold",
  cancel: "Order cancelled",
  return: "Returned",
  manual: "Edited",
  bulk: "Bulk edit",
  import: "Sheet upload",
  tracking: "Tracking changed",
  purchase: "Purchase",
  wastage: "Wastage",
}
