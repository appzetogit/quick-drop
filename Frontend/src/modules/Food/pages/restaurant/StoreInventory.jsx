import { lazy, Suspense, useMemo } from "react"
import { Loader2 } from "lucide-react"
import { InventoryScopeContext, sellerInventoryScope } from "@food/pages/admin/inventory/inventoryShared"

/**
 * A store's own Inventory (client, 2026-11-23: "make the seller panel like the
 * admin inventory, alongside"): the admin's Quick commerce inventory screens --
 * dashboard, fruits & veg daily sheet, purchases & suppliers, reports -- run in
 * seller scope, so they show and change this store only. Excel import, bulk
 * prices and product copy stay with the admin (they would skip approval).
 *
 * Routes: /food/restaurant/store-inventory[/fresh|/purchases|/reports]
 */
const PAGES = {
  dashboard: lazy(() => import("@food/pages/admin/inventory/InventoryDashboard")),
  fresh: lazy(() => import("@food/pages/admin/inventory/FreshSheet")),
  purchases: lazy(() => import("@food/pages/admin/inventory/Purchases")),
  reports: lazy(() => import("@food/pages/admin/inventory/InventoryReports")),
}

export default function StoreInventory({ page = "dashboard" }) {
  const scope = useMemo(() => sellerInventoryScope(), [])
  const Page = PAGES[page] || PAGES.dashboard
  return (
    <InventoryScopeContext.Provider value={scope}>
      <div className="min-h-screen bg-neutral-50 p-4 lg:p-6">
        <div className="mx-auto max-w-6xl">
          <Suspense fallback={<div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-neutral-400" /></div>}>
            <Page />
          </Suspense>
        </div>
      </div>
    </InventoryScopeContext.Provider>
  )
}
