import { useEffect, useSyncExternalStore } from "react"
import { adminAccountsAPI } from "@food/api"

/**
 * What the signed-in admin may open, shared by every admin panel.
 *
 * The server is the gate (core/admin/adminAccessPolicy.js refuses anything not
 * granted). This decides what the panel SHOWS, so a sub-admin is not offered
 * sections that would only answer "no access". It is fetched fresh from
 * /platform/admins/me rather than read off the login response, so a change made
 * by a superadmin shows on the sub-admin's next page load, not their next login.
 */

const STORAGE_KEY = "admin_access"
const listeners = new Set()
let state = readStored()
let inflight = null

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function setState(next) {
  state = next
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable: the in-memory copy still works for this tab */
  }
  listeners.forEach((fn) => fn())
}

export function refreshAdminAccess() {
  if (inflight) return inflight
  inflight = adminAccountsAPI
    .me()
    .then((res) => {
      const data = res?.data?.data || null
      if (data) setState(data)
      return data
    })
    .catch(() => state)
    .finally(() => {
      inflight = null
    })
  return inflight
}

export const clearAdminAccess = () => setState(null)

const subscribe = (fn) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Signing out (or in as someone else) removes the stored copy; drop the
// in-memory one with it so the next admin never sees the last one's menu.
const snapshot = () => {
  try {
    if (state && !localStorage.getItem(STORAGE_KEY)) state = null
  } catch {
    /* keep the in-memory copy */
  }
  return state
}

/** The access record, refreshed once per mount of the panel. Null until known. */
export function useAdminAccess() {
  const access = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    refreshAdminAccess()
  }, [])
  return access
}

/* ------------------------------------------------------------ permissions */

export const isRestricted = (access) => Boolean(access) && access.isSuperAdmin === false

export function can(access, resource, action = "read") {
  if (!access || !isRestricted(access)) return true
  const perms = access.permissions || []
  if (perms.includes("*")) return true
  if (!resource) return true
  return perms.includes(`${resource}.write`) || (action === "read" && perms.includes(`${resource}.read`))
}

export function hasPanel(access, service) {
  if (!access || !isRestricted(access)) return true
  return (access.servicesAccess || []).includes(service)
}

/* ---------------------------------------------------------------- pages */

const PANEL_BASES = [
  { base: "/admin/quick-commerce", service: "quickCommerce" },
  { base: "/admin/medical", service: "medical" },
  { base: "/admin/food", service: "food" },
]

export const panelOfPath = (pathname = "") =>
  PANEL_BASES.find((p) => pathname === p.base || pathname.startsWith(`${p.base}/`)) || null

/*
 * Screen paths (after the panel base) to the permission they need. Ordered:
 * the first matching prefix wins, so specific entries sit above general ones.
 * Mirrors the server's API table closely enough that a screen shown here does
 * not immediately 403 on its own data.
 */
const PAGE_RULES = [
  ["/management/admins", "subadmins"],
  ["/stock", "foods"],
  ["/point-of-sale", "pos"],
  ["/status-monitor", "dashboard"],
  ["/food-approval", "foods"],
  ["/foods", "foods"],
  ["/addons", "foods"],
  ["/global-pricing", "foods"],
  ["/categories", "categories"],
  ["/zone-setup", "zones"],
  ["/restaurants/complaints", "support"],
  ["/restaurants", "restaurants"],
  ["/free-delivery", "restaurants"],
  ["/delivery-radius", "restaurants"],
  ["/verification", "restaurants"],
  ["/drug-licences", "restaurants"],
  ["/prescriptions", "orders"],
  ["/requests", "orders"],
  ["/orders", "orders"],
  ["/order-detect-delivery", "orders"],
  ["/order-refunds", "orders"],
  ["/coupons", "promotions"],
  ["/99-store", "promotions"],
  ["/cashback", "promotions"],
  ["/referral-settings", "referrals"],
  ["/customers", "customers"],
  ["/support-tickets", "support"],
  ["/delivery-support-tickets", "support"],
  ["/contact-messages", "support"],
  ["/safety-emergency-reports", "support"],
  ["/fee-settings", "fee_settings"],
  ["/packaging-charges", "fee_settings"],
  ["/delivery-withdrawal", "wallet"],
  ["/delivery-boy-wallet", "wallet"],
  ["/restaurant-withdraws", "wallet"],
  ["/delivery-cash-limit", "delivery"],
  ["/cash-limit-settlement", "delivery"],
  ["/delivery-emergency-help", "delivery"],
  ["/delivery-partners", "delivery"],
  ["/transaction-report", "reports"],
  ["/order-report", "reports"],
  ["/tax-report", "reports"],
  ["/restaurant-report", "reports"],
  ["/customer-report", "reports"],
  ["/hero-banner-management", "cms"],
  ["/promotional-banner", "cms"],
  ["/banners", "cms"],
  ["/broadcast-notification", "cms"],
  ["/pages-social-media", "cms"],
  ["/dining", "dining"],
  ["/business-setup", "settings"],
  ["/map-settings", "settings"],
  ["/petpooja-settings", "settings"],
]

export function resourceForPath(pathname = "") {
  if (pathname.startsWith("/admin/master")) return "__owner__"
  const panel = panelOfPath(pathname)
  if (!panel) return null
  const rest = pathname.slice(panel.base.length) || "/"
  if (rest === "/" || rest === "") return "dashboard"
  const hit = PAGE_RULES.find(([prefix]) => rest === prefix || rest.startsWith(`${prefix}/`) || rest.startsWith(prefix))
  return hit ? hit[1] : null
}

/** Can this admin open the screen at `pathname`? */
export function canOpenPath(access, pathname) {
  if (!isRestricted(access)) return true
  const resource = resourceForPath(pathname)
  if (resource === "__owner__") return false
  const panel = panelOfPath(pathname)
  if (panel && !hasPanel(access, panel.service)) return false
  return can(access, resource, "read")
}

/** Drop every menu entry the admin cannot open; sections left empty go too. */
export function filterMenuForAccess(nodes = [], access) {
  if (!isRestricted(access)) return nodes
  return nodes
    .map((node) => {
      const children = node.items || node.subItems
      if (Array.isArray(children)) {
        const kept = filterMenuForAccess(children, access)
        if (!kept.length) return null
        return node.items ? { ...node, items: kept } : { ...node, subItems: kept }
      }
      if (node.path) return canOpenPath(access, node.path) ? node : null
      return node
    })
    .filter(Boolean)
}

/** The first screen a restricted admin can open in this menu, for redirects. */
export function firstOpenPath(nodes = [], access) {
  for (const node of filterMenuForAccess(nodes, access)) {
    if (node.path) return node.path
    const children = node.items || node.subItems || []
    const inner = firstOpenPath(children, access)
    if (inner) return inner
  }
  return null
}
