import { lazy, Suspense } from "react"
import { Link, Navigate, Route, Routes } from "react-router-dom"
import { Loader2 } from "lucide-react"

const ChoosePartner = lazy(() => import("./pages/ChoosePartner"))
const PartnerLogin = lazy(() => import("./pages/PartnerLogin"))
const PartnerApply = lazy(() => import("./pages/PartnerApply"))
const PartnerStatus = lazy(() => import("./pages/PartnerStatus"))

/**
 * /partner -- one door for everyone who sells on Quick Drop.
 *
 *   /partner                 choose Restaurant, Store or Medical store
 *   /partner/login/:type     phone and OTP (restaurants go to their own login)
 *   /partner/apply/:type     the application, new or being fixed
 *   /partner/status          waiting for review, rejected, or approved
 */
export default function PartnerApp() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
          <Link to="/partner" className="text-base font-bold tracking-tight">
            Quick Drop <span className="font-medium text-emerald-700">Partner</span>
          </Link>
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-800">
            quickdropsindia.com
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Suspense
          fallback={
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading
            </div>
          }
        >
          <Routes>
            <Route index element={<ChoosePartner />} />
            <Route path="login/:type" element={<PartnerLogin />} />
            <Route path="apply/:type" element={<PartnerApply />} />
            <Route path="status" element={<PartnerStatus />} />
            <Route path="*" element={<Navigate to="/partner" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}
