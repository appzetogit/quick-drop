import { createContext, useContext } from "react"
import apiClient from "@food/api/axios"

/**
 * Lets the restaurant portal's menu screens (item editor, add-on manager) run
 * somewhere else -- the admin panel, acting for one restaurant -- with no
 * second copy of the screens.
 *
 * Without a provider the screens behave exactly as in the restaurant portal.
 * With one they call `api` instead of restaurantAPI and use its paths.
 *
 *   { api, itemPath(id), categoriesPath, onBack(), restaurantName, isAdmin }
 */
export const MenuEditorContext = createContext(null)
export const useMenuEditor = () => useContext(MenuEditorContext)

/**
 * The calls the item editor and add-on manager make, sent to the admin's
 * "act as restaurant" routes (Backend food/admin/routes/restaurantPortal.routes.js).
 * Same names and arguments as restaurantAPI, so the screens need no changes.
 */
export function adminMenuApiFor(restaurantId) {
  const base = `/food/admin/restaurants/${encodeURIComponent(String(restaurantId))}/portal`
  const cfg = (params) => ({ ...(params ? { params } : {}), contextModule: "admin" })
  return {
    getMenu: (params = {}) => apiClient.get(`${base}/menu`, cfg(params)),
    getCategories: (params = {}) => apiClient.get(`${base}/categories`, cfg({ compact: true, limit: 1000, ...params })),
    getAddons: (params = {}) => apiClient.get(`${base}/item-extras`, cfg({ limit: 100, page: 1, ...params })),
    getCommission: () => apiClient.get(`${base}/commission`, cfg()),
    getTaxSettings: () => apiClient.get(`${base}/tax-settings`, cfg()),
    createFood: (body) => apiClient.post(`${base}/foods`, body ?? {}, cfg()),
    updateFood: (id, body) => apiClient.patch(`${base}/foods/${encodeURIComponent(String(id))}`, body ?? {}, cfg()),
    addAddon: (body) => apiClient.post(`${base}/item-extras`, body ?? {}, cfg()),
    updateAddon: (id, body) => apiClient.patch(`${base}/item-extras/${encodeURIComponent(String(id))}`, body ?? {}, cfg()),
    deleteAddon: (id) => apiClient.delete(`${base}/item-extras/${encodeURIComponent(String(id))}`, cfg()),
  }
}
