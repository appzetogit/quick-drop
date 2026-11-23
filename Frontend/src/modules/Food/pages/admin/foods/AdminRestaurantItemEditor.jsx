import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { adminAPI } from "@food/api"
import ItemDetailsPage from "@food/pages/restaurant/ItemDetailsPage"
import { MenuEditorContext, adminMenuApiFor } from "@food/context/MenuEditorContext"

/**
 * Admin > Food > Foods > Add / Edit: the restaurant portal's own item editor,
 * run for one restaurant. Same screen, same checks; saving goes through the
 * restaurant's rules, so a new dish or a real change waits for approval on
 * Food Approval, exactly as when the restaurant makes it.
 *
 * Route: /admin/food/restaurants/:restaurantId/menu/item/:id ("new" to add).
 */
export default function AdminRestaurantItemEditor() {
  const { restaurantId } = useParams()
  const navigate = useNavigate()
  const [restaurantName, setRestaurantName] = useState("")

  useEffect(() => {
    let alive = true
    adminAPI
      .getRestaurantById?.(restaurantId)
      ?.then((res) => {
        const r = res?.data?.data?.restaurant || res?.data?.data || {}
        if (alive) setRestaurantName(r.restaurantName || r.name || "")
      })
      .catch(() => {})
    return () => { alive = false }
  }, [restaurantId])

  const editor = useMemo(() => ({
    api: adminMenuApiFor(restaurantId),
    isAdmin: true,
    isQcStore: false,
    itemPath: (itemId) => `/admin/food/restaurants/${encodeURIComponent(String(restaurantId))}/menu/item/${encodeURIComponent(String(itemId))}`,
    categoriesPath: "/admin/food/categories",
    onBack: () => navigate("/admin/food/foods"),
  }), [restaurantId, navigate])

  return (
    <MenuEditorContext.Provider value={editor}>
      <div className="min-h-screen bg-slate-50">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <button
            type="button"
            onClick={() => navigate("/admin/food/foods")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeft className="h-4 w-4" /> Foods
          </button>
          <p className="text-sm text-slate-700">
            Editing as <span className="font-semibold">{restaurantName || "the restaurant"}</span>.
            A new dish, or a change to its name, price, photo, description or category, goes to
            <span className="font-semibold"> Food Approval</span> like the restaurant&apos;s own.
          </p>
        </div>
        <div className="mx-auto max-w-3xl">
          <ItemDetailsPage />
        </div>
      </div>
    </MenuEditorContext.Provider>
  )
}
