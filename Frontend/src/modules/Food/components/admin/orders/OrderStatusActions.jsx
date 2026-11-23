import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Check, ChefHat, PackageCheck, Loader2 } from "lucide-react"
import { adminAPI } from "@food/api"

/**
 * The kitchen steps an admin can take on an order from its details popup:
 * Accept, Processing (preparing) and Ready (ready for pickup). Only the steps
 * still ahead of the order are offered; the server refuses moving backwards.
 * Pickup and delivery stay with the rider's app (OTP), so they are not here.
 */
const STEPS = [
  { status: "confirmed", label: "Accept", icon: Check, tone: "bg-emerald-600 hover:bg-emerald-700" },
  { status: "preparing", label: "Processing", icon: ChefHat, tone: "bg-amber-600 hover:bg-amber-700" },
  { status: "ready_for_pickup", label: "Ready", icon: PackageCheck, tone: "bg-sky-600 hover:bg-sky-700" },
]
const ORDER = ["created", "confirmed", "preparing", "ready_for_pickup"]
const LABEL = {
  created: "New (not accepted)",
  confirmed: "Accepted",
  preparing: "Processing",
  ready_for_pickup: "Ready for pickup",
}

const rawStatusOf = (order) =>
  String(order?.rawOrderStatus || order?.orderStatusRaw || order?.status || order?.orderStatus || "")
    .toLowerCase()
    .replace(/\s+/g, "_")

export default function OrderStatusActions({ order, vertical, onChanged }) {
  const incoming = rawStatusOf(order)
  const [status, setStatus] = useState(incoming)
  const [busy, setBusy] = useState("")
  // On the status VALUE, not the object: Master > Orders re-creates the order
  // object on every refresh, which would put back the pre-update status.
  useEffect(() => { setStatus(incoming) }, [incoming])

  const at = ORDER.indexOf(status)
  // Not in the kitchen part of the order's life (picked up, delivered, cancelled...).
  if (at < 0) return null
  const next = STEPS.filter((s) => ORDER.indexOf(s.status) > at)
  const orderId = order?._id || order?.id || order?.orderId

  const move = async (step) => {
    if (!orderId || busy) return
    setBusy(step.status)
    try {
      const res = await adminAPI.setOrderStatus(vertical || "food", orderId, step.status, "Updated by admin")
      if (res?.data?.success === false) throw new Error(res?.data?.message || "Could not update the order")
      setStatus(step.status)
      toast.success(`Order marked ${LABEL[step.status] || step.label}`)
      onChanged?.()
    } catch (err) {
      toast.error(err?.response?.data?.message || err?.message || "Could not update the order")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="border-t border-slate-200 pt-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Order status</h3>
      <p className="mb-3 text-sm text-slate-600">
        Now: <span className="font-semibold text-slate-900">{LABEL[status] || status}</span>
      </p>
      {next.length ? (
        <div className="flex flex-wrap gap-2">
          {next.map((s) => {
            const Icon = s.icon
            return (
              <button
                key={s.status}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => move(s)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60 ${s.tone}`}
              >
                {busy === s.status ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                {s.label}
              </button>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-500">Ready for pickup. The rider takes it from here.</p>
      )}
    </div>
  )
}
