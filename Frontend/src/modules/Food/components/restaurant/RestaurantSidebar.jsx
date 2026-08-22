import { useMemo } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  BarChart3,
  Building2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Compass,
  Download,
  FileText,
  LifeBuoy,
  Landmark,
  Map,
  Package,
  Star,
  Store,
  Tag,
  Utensils,
  Wallet,
} from "lucide-react"

/**
 * Desktop sidebar for the restaurant dashboard.
 * Mirrors the Food admin shell (fixed dark rail, collapsible) so both
 * dashboards read as one product. Hidden below `lg` — mobile keeps the
 * existing bottom nav.
 */

const getNavSections = (base) => [
  {
    label: "OPERATIONS",
    items: [
      { label: "Orders", path: `${base}`, icon: FileText, exact: true },
      { label: "All orders", path: `${base}/orders/all`, icon: Clock },
      { label: "Inventory", path: `${base}/inventory`, icon: Package },
      { label: "Menu categories", path: `${base}/menu-categories`, icon: Utensils },
      { label: "Reservations", path: `${base}/reservations`, icon: Store },
    ],
  },
  {
    label: "GROWTH",
    items: [
      { label: "Coupons", path: `${base}/coupon`, icon: Tag },
      { label: "Analytics", path: `${base}/analytics`, icon: BarChart3 },
      { label: "Ratings & reviews", path: `${base}/ratings-reviews`, icon: Star },
      { label: "Explore", path: `${base}/explore`, icon: Compass },
    ],
  },
  {
    label: "FINANCE",
    items: [
      { label: "Payouts", path: `${base}/hub-finance`, icon: Wallet },
      { label: "Withdrawals", path: `${base}/withdrawal-history`, icon: Landmark },
      { label: "Reports", path: `${base}/download-report`, icon: Download },
    ],
  },
  {
    label: "OUTLET",
    items: [
      { label: "Outlet info", path: `${base}/outlet-info`, icon: Building2 },
      { label: "Timings", path: `${base}/outlet-timings`, icon: Clock },
      { label: "Zones", path: `${base}/zone-setup`, icon: Map },
      { label: "Manage outlets", path: `${base}/manage-outlets`, icon: Store },
      { label: "Help centre", path: `${base}/help-centre/support`, icon: LifeBuoy },
    ],
  },
]

export default function RestaurantSidebar({ collapsed, onToggleCollapse }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const base = pathname.startsWith("/food/restaurant") ? "/food/restaurant" : "/restaurant"
  const sections = useMemo(() => getNavSections(base), [base])

  const isActive = (item) =>
    item.exact
      ? pathname === item.path
      : pathname === item.path || pathname.startsWith(`${item.path}/`)

  return (
    <aside
      className={`hidden lg:flex fixed left-0 top-0 bottom-0 z-40 flex-col overflow-hidden border-r border-neutral-800/60 bg-neutral-950 transition-[width] duration-300 ${
        collapsed ? "w-20" : "w-72"
      }`}
    >
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-neutral-800/60 px-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white">
          <Store className="h-5 w-5 text-black" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">Restaurant</p>
            <p className="truncate text-[11px] text-neutral-500">Partner dashboard</p>
          </div>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {sections.map((section) => (
          <div key={section.label} className="mb-5">
            {!collapsed && (
              <p className="mb-2 px-3 text-[10px] font-semibold tracking-wider text-neutral-600">
                {section.label}
              </p>
            )}
            <div className="space-y-1">
              {section.items.map((item) => {
                const Icon = item.icon
                const active = isActive(item)
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => navigate(item.path)}
                    title={collapsed ? item.label : undefined}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-white text-black shadow-[0_4px_12px_rgba(255,255,255,0.15)]"
                        : "text-neutral-400 hover:bg-neutral-900 hover:text-white"
                    } ${collapsed ? "justify-center" : ""}`}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex h-12 shrink-0 items-center justify-center gap-2 border-t border-neutral-800/60 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-white"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4" />
        ) : (
          <>
            <ChevronLeft className="h-4 w-4" />
            <span>Collapse</span>
          </>
        )}
      </button>
    </aside>
  )
}
