import { useNavigate } from "react-router-dom"
import { ChevronRight, Pill, ShoppingBasket, UtensilsCrossed } from "lucide-react"
import { PARTNER_TYPES } from "../partnerApi"

const OPTIONS = [
  { type: "restaurant", icon: UtensilsCrossed, tint: "bg-orange-50 text-orange-600" },
  { type: "store", icon: ShoppingBasket, tint: "bg-sky-50 text-sky-600" },
  { type: "medical", icon: Pill, tint: "bg-emerald-50 text-emerald-600" },
]

export default function ChoosePartner() {
  const navigate = useNavigate()

  const open = (type) => {
    // Restaurants already have a complete sign-in and onboarding of their own.
    if (type === "restaurant") navigate("/food/restaurant/login")
    else navigate(`/partner/login/${type}`)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Sell on Quick Drop</h1>
        <p className="mt-1 text-slate-600">
          Sign in or register your business. New numbers go straight to registration.
        </p>
      </div>
      <div className="grid gap-3">
        {OPTIONS.map(({ type, icon: Icon, tint }) => (
          <button
            key={type}
            type="button"
            onClick={() => open(type)}
            className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-slate-300 hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${tint}`}>
              <Icon className="h-6 w-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-semibold">{PARTNER_TYPES[type].label}</span>
              <span className="block text-sm text-slate-500">{PARTNER_TYPES[type].blurb}</span>
            </span>
            <ChevronRight className="h-5 w-5 text-slate-400" />
          </button>
        ))}
      </div>
    </div>
  )
}
