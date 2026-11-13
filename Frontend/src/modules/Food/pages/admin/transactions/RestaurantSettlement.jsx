import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, ArrowLeft, Download, Loader2, Lock, PauseCircle, PlayCircle, RefreshCw } from "lucide-react"
import { settlementAPI } from "@food/api"
import { downloadSettlementPdf } from "./settlementPdf"

/*
 * Food partner settlement, per restaurant per 10-day cycle (1-10, 11-20,
 * 21-end). Backend: modules/food/admin/settlements. Paying locks the cycle's
 * bills under one settlement ID, records the payment in the restaurant's
 * wallet, and carries any unpaid rest into the next settlement.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const CYCLES = [
  [1, "1 to 10"],
  [2, "11 to 20"],
  [3, "21 to 30/31"],
]
const MODES = [
  ["upi", "UPI"],
  ["bank_transfer", "Bank Transfer"],
  ["cash", "Cash"],
]
const STATUS = {
  paid: { label: "Paid", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  partial: { label: "Partly paid", cls: "bg-amber-50 text-amber-900 ring-amber-200" },
  pending: { label: "Pending", cls: "bg-sky-50 text-sky-800 ring-sky-200" },
  on_hold: { label: "On hold", cls: "bg-red-50 text-red-800 ring-red-200" },
  carried_forward: { label: "Carried forward", cls: "bg-violet-50 text-violet-800 ring-violet-200" },
  nothing: { label: "No orders", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
}
const rs = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—")
const errText = (err, fallback) => err?.response?.data?.message || err?.message || fallback
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
/** The last cycle that has ended: the one to settle now. */
function lastClosedCycle(now = new Date()) {
  const d = now.getDate()
  let y = now.getFullYear()
  let m = now.getMonth() + 1
  if (d > 20) return { year: y, month: m, cycle: 2 }
  if (d > 10) return { year: y, month: m, cycle: 1 }
  m -= 1
  if (m < 1) {
    m = 12
    y -= 1
  }
  return { year: y, month: m, cycle: 3 }
}
const newRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

function Pill({ status }) {
  const s = STATUS[status] || STATUS.pending
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${s.cls}`}>{s.label}</span>
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
    </label>
  )
}
const input = "h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"

export default function RestaurantSettlement() {
  const initial = useMemo(() => lastClosedCycle(), [])
  const [restaurants, setRestaurants] = useState([])
  const [officers, setOfficers] = useState([])
  const [restaurantId, setRestaurantId] = useState("")
  const [year, setYear] = useState(initial.year)
  const [month, setMonth] = useState(initial.month)
  const [cycle, setCycle] = useState(initial.cycle)
  const [data, setData] = useState(null)
  const [overview, setOverview] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    settlementAPI.restaurants().then((r) => setRestaurants(r?.data?.data || [])).catch(() => toast.error("Could not load restaurants"))
    settlementAPI.officers().then((r) => setOfficers(r?.data?.data || [])).catch(() => {})
  }, [])

  const params = { year, month, cycle }
  const load = useCallback(async () => {
    setLoading(true)
    try {
      if (restaurantId) {
        const [c, h] = await Promise.all([settlementAPI.cycle({ restaurantId, year, month, cycle }), settlementAPI.history({ restaurantId })])
        setData(c?.data?.data || null)
        setHistory(h?.data?.data || [])
      } else {
        const o = await settlementAPI.overview({ year, month, cycle })
        setOverview(o?.data?.data || null)
        setData(null)
      }
    } catch (err) {
      toast.error(errText(err, "Could not load the settlement"))
    } finally {
      setLoading(false)
    }
  }, [restaurantId, year, month, cycle])
  useEffect(() => {
    load()
  }, [load])

  const years = useMemo(() => {
    const now = new Date().getFullYear()
    return [now - 2, now - 1, now, now + 1].filter((y) => y >= 2024)
  }, [])
  const restaurantName = restaurants.find((r) => r.id === restaurantId)?.name || data?.restaurant?.name || ""
  const open = (rid, y = year, m = month, c = cycle) => {
    setRestaurantId(rid)
    setYear(y)
    setMonth(m)
    setCycle(c)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Restaurant settlement</h1>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Every restaurant is settled per 10-day cycle. Bill total = Basic + Packing + GST on the bill; Restaurant payable = Bill total − Commission. Clear Payment locks the cycle's bills under one Settlement ID, so no bill is paid twice.
            </p>
          </div>
          <button type="button" onClick={load} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {/* 1. Selection */}
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(240px,2fr)_1fr_1fr_auto]">
            <Field label="Restaurant">
              <select value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)} className={input}>
                <option value="">All restaurants (this cycle)</option>
                {restaurants.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{r.city ? ` · ${r.city}` : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Month">
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={input}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </Field>
            <Field label="Year">
              <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={input}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </Field>
            <Field label="Payment cycle">
              <div role="group" aria-label="Payment cycle" className="flex h-10 gap-1 rounded-lg bg-slate-100 p-1">
                {CYCLES.map(([c, label]) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={cycle === c}
                    onClick={() => setCycle(c)}
                    className={`whitespace-nowrap rounded-md px-3 text-sm font-semibold ${cycle === c ? "bg-slate-900 text-white" : "text-slate-700"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          </div>
        </section>

        {loading && !data && !overview && (
          <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading</p>
        )}

        {!restaurantId && overview && <Overview overview={overview} onOpen={(rid) => open(rid)} />}

        {restaurantId && data && (
          <>
            <button type="button" onClick={() => setRestaurantId("")} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
              <ArrowLeft className="h-4 w-4" /> All restaurants
            </button>
            <CycleView data={data} restaurantName={restaurantName} officers={officers} params={params} restaurantId={restaurantId} onChanged={load} />
            <History rows={history} current={data.cycle.key} onOpen={(h) => open(restaurantId, h.year, h.month, h.cycle)} />
          </>
        )}
      </div>
    </div>
  )
}

function Overview({ overview, onOpen }) {
  const t = overview.totals
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <h2 className="text-base font-semibold text-slate-900">All restaurants · {overview.cycle.label}</h2>
        <p className="text-sm text-slate-600">
          {t.restaurants} restaurants · {t.orders} orders · payable {rs(t.payable)} · paid {rs(t.paid)} · <strong className="text-slate-900">pending {rs(t.balance)}</strong>
        </p>
      </div>
      {!overview.cycle.closed && <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-900">This cycle is still running; more orders will be added until it ends.</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2.5 font-medium">Restaurant</th>
              <th className="px-4 py-2.5 font-medium">Settlement ID</th>
              <th className="px-4 py-2.5 text-right font-medium">Orders</th>
              <th className="px-4 py-2.5 text-right font-medium">Bill amount</th>
              <th className="px-4 py-2.5 text-right font-medium">Commission</th>
              <th className="px-4 py-2.5 text-right font-medium">Payable</th>
              <th className="px-4 py-2.5 text-right font-medium">Paid</th>
              <th className="px-4 py-2.5 text-right font-medium">Pending</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {overview.rows.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">No delivered orders in this cycle.</td></tr>}
            {overview.rows.map((r) => (
              <tr key={r.restaurantId} onClick={() => onOpen(r.restaurantId)} className="cursor-pointer hover:bg-slate-50">
                <td className="px-4 py-2.5 font-medium text-slate-900"><button type="button" className="text-left underline-offset-2 hover:underline">{r.restaurantName}</button></td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{r.settlementNo || "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{r.orders}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rs(r.billTotal)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rs(r.commission)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rs(r.payable + r.carriedIn)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rs(r.paid)}</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{rs(r.balance)}</td>
                <td className="px-4 py-2.5"><Pill status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function CycleView({ data, restaurantName, officers, params, restaurantId, onChanged }) {
  const t = data.totals
  const showDeductions = t.deductions > 0
  const lineStatus = data.status === "partial" ? "partial" : data.status === "nothing" ? "pending" : data.status
  const tiles = [
    ["Total orders", String(t.orders)],
    ["Total basic amount", rs(t.basic)],
    ["Total packing charges", rs(t.packing)],
    ["Total GST", rs(t.gst)],
    ["Total bill amount", rs(t.billTotal)],
    ["Total commission", rs(t.commission)],
    ["Total restaurant payable", rs(t.payable + data.carriedIn), data.carriedIn > 0 ? `incl. ${rs(data.carriedIn)} brought forward` : ""],
    ["Total paid", rs(data.paid), "", "text-emerald-800"],
    ["Total pending", rs(data.balance), data.carriedOut > 0 ? `${rs(data.carriedOut)} moved to ${data.settlement?.carriedTo}` : "", data.balance > 0 ? "text-red-700" : "text-slate-900"],
  ]

  return (
    <>
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Settlement {data.settlement ? "" : "(not locked yet)"}</p>
            <h2 className="mt-0.5 text-xl font-bold text-slate-900">{restaurantName}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className="font-mono">{data.settlementNo}</span>
              <span>·</span>
              <span>{data.cycle.label}</span>
              <Pill status={data.status} />
              {data.settlement && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Lock className="h-3.5 w-3.5" /> locked {day(data.settlement.lockedAt)}{data.settlement.lockedBy ? ` by ${data.settlement.lockedBy}` : ""}</span>}
            </p>
            {data.settlement?.onHold && data.settlement.holdNote && <p className="mt-1 text-sm text-red-800">Hold reason: {data.settlement.holdNote}</p>}
          </div>
          <button
            type="button"
            disabled={!data.lines.length && !data.carriedIn}
            onClick={() => downloadSettlementPdf({ ...data, restaurant: { ...data.restaurant, name: restaurantName } }).catch(() => toast.error("Could not make the PDF"))}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            <Download className="h-4 w-4" /> Download PDF statement
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {tiles.map(([label, value, note, tone]) => (
            <div key={label} className="rounded-lg border border-slate-200 p-3">
              <p className="text-[11px] font-medium text-slate-500">{label}</p>
              <p className={`mt-1 text-base font-bold tabular-nums ${tone || "text-slate-900"}`}>{value}</p>
              {note && <p className="mt-0.5 text-[11px] text-slate-500">{note}</p>}
            </div>
          ))}
        </div>
      </section>

      <Notices data={data} />

      {/* 2. Bill-wise details */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h3 className="text-base font-semibold text-slate-900">Bill-wise details</h3>
          {data.unlockedCount > 0 && data.settlement && (
            <p className="text-xs text-amber-800">{data.unlockedCount} bill{data.unlockedCount === 1 ? "" : "s"} delivered after locking: added at the next payment.</p>
          )}
        </div>
        <div className="max-h-[520px] overflow-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2.5 font-medium">Order date</th>
                <th className="px-3 py-2.5 font-medium">Order ID</th>
                <th className="px-3 py-2.5 text-right font-medium">Basic amount</th>
                <th className="px-3 py-2.5 text-right font-medium">Packing</th>
                <th className="px-3 py-2.5 text-right font-medium">GST on bill</th>
                <th className="px-3 py-2.5 text-right font-medium">Total bill</th>
                <th className="px-3 py-2.5 text-right font-medium">Commission</th>
                {showDeductions && <th className="px-3 py-2.5 text-right font-medium" title="GST paid to the government by Quickdrops for this restaurant, and discounts the restaurant offered">Deductions*</th>}
                <th className="px-3 py-2.5 text-right font-medium">Restaurant payable</th>
                <th className="px-3 py-2.5 font-medium">Payment status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.lines.length === 0 && <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-500">No delivered orders in this cycle.</td></tr>}
              {data.lines.map((l) => (
                <tr key={l.orderId} className={l.locked ? "" : data.settlement ? "bg-amber-50/50" : ""}>
                  <td className="px-3 py-2 text-slate-700">{day(l.orderDate)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-800">{l.orderNo}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{rs(l.basic)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{rs(l.packing)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{rs(l.gst)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{rs(l.billTotal)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">−{rs(l.commission)}</td>
                  {showDeductions && <td className="px-3 py-2 text-right tabular-nums text-slate-700">{l.deductions ? `−${rs(l.deductions)}` : "—"}</td>}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{rs(l.payable)}</td>
                  <td className="px-3 py-2">{l.locked || !data.settlement ? <Pill status={lineStatus} /> : <span className="text-xs text-amber-800">Not locked yet</span>}</td>
                </tr>
              ))}
            </tbody>
            {data.lines.length > 0 && (
              <tfoot className="sticky bottom-0 bg-slate-100 font-semibold">
                <tr>
                  <td className="px-3 py-2.5" colSpan={2}>{t.orders} orders</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rs(t.basic)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rs(t.packing)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rs(t.gst)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{rs(t.billTotal)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">−{rs(t.commission)}</td>
                  {showDeductions && <td className="px-3 py-2.5 text-right tabular-nums">−{rs(t.deductions)}</td>}
                  <td className="px-3 py-2.5 text-right tabular-nums">{rs(t.payable)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {showDeductions && (
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            * Deductions: the food GST that Quickdrops pays to the government for this restaurant (set in Restaurant GST), and discounts the restaurant itself offered. Payable is exactly what the restaurant's app shows as earned.
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <PaymentPanel data={data} officers={officers} params={params} restaurantId={restaurantId} restaurantName={restaurantName} onChanged={onChanged} />
        <Payments payments={data.payments} />
      </div>
    </>
  )
}

function Notices({ data }) {
  const manual = data.wallet.pendingRequests.filter((r) => !r.automatic)
  const auto = data.wallet.pendingRequests.filter((r) => r.automatic)
  const items = []
  if (!data.cycle.closed) items.push(["amber", "This cycle is still running. Orders delivered before it ends will be added; pay after it closes."])
  if (data.carriedInPreview) items.push(["sky", `${rs(data.carriedIn)} unpaid from earlier settlements (${data.earlierOpen.filter((e) => !e.onHold).map((e) => e.settlementNo).join(", ")}) will be brought into this settlement when it is paid.`])
  const held = data.earlierOpen.filter((e) => e.onHold)
  if (held.length) items.push(["red", `On hold and not brought forward: ${held.map((e) => `${e.settlementNo} (${rs(e.balance)})`).join(", ")}.`])
  if (manual.length) items.push(["red", `The restaurant asked to withdraw ${rs(manual[0].amount)} and the request is waiting. Approve or reject it in Restaurant Withdraws first, so the same money is not paid twice.`])
  if (auto.length) items.push(["sky", `An automatic withdrawal request of ${rs(auto[0].amount)} is waiting. Clearing payment here closes it, so the restaurant is paid once.`])
  if (data.balance > 0 && data.wallet.unpaidEarnings < data.balance - 0.01) {
    items.push(["amber", `The restaurant's unpaid earnings are ${rs(Math.max(0, data.wallet.unpaidEarnings))}: part of this was already paid through withdrawals. Payments here are limited to that.`])
  }
  if (!items.length) return null
  const tone = { amber: "border-amber-200 bg-amber-50 text-amber-900", sky: "border-sky-200 bg-sky-50 text-sky-900", red: "border-red-200 bg-red-50 text-red-900" }
  return (
    <div className="space-y-2">
      {items.map(([k, text]) => (
        <p key={text} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${tone[k]}`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {text}
        </p>
      ))}
    </div>
  )
}

/* 5. Payment management */
function PaymentPanel({ data, officers, params, restaurantId, restaurantName, onChanged }) {
  const [officerId, setOfficerId] = useState("")
  const [mode, setMode] = useState("upi")
  const [utr, setUtr] = useState("")
  const [paidOn, setPaidOn] = useState(todayIso())
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState("")
  const requestId = useRef(newRequestId())
  const maxPay = Math.max(0, Math.min(data.balance, data.wallet.unpaidEarnings))

  useEffect(() => {
    setAmount(maxPay > 0 ? String(Math.round(maxPay * 100) / 100) : "")
    setConfirm(false)
    setUtr("")
    setNote("")
    requestId.current = newRequestId()
  }, [data.cycle.key, data.restaurant.id, data.balance, maxPay])

  const onHold = data.settlement?.onHold
  const carried = Boolean(data.settlement?.carriedTo)
  const blocked = onHold || carried || data.balance <= 0 || data.wallet.pendingRequests.some((r) => !r.automatic)
  const amt = Number(amount)
  const valid = officerId && amt >= 1 && amt <= data.balance + 0.001 && (mode === "cash" || utr.trim().length >= 4) && paidOn

  const pay = async () => {
    setBusy("pay")
    try {
      const res = await settlementAPI.pay({ restaurantId, ...params, amount: amt, mode, utr: utr.trim(), paidOn, officerId, note, requestId: requestId.current })
      const r = res?.data?.data
      toast.success(r?.duplicate ? "This payment was already recorded" : `${rs(amt)} recorded on ${r?.settlementNo}. ${r?.balance > 0 ? `${rs(r.balance)} still pending.` : "Settlement fully paid."}`)
      requestId.current = newRequestId()
      setConfirm(false)
      onChanged()
    } catch (err) {
      toast.error(errText(err, "Could not record the payment"))
    } finally {
      setBusy("")
    }
  }
  const hold = async (next) => {
    setBusy("hold")
    try {
      await settlementAPI.hold({ restaurantId, ...params, hold: next, note })
      toast.success(next ? "Settlement put on hold" : "Hold released")
      onChanged()
    } catch (err) {
      toast.error(errText(err, "Could not change the hold"))
    } finally {
      setBusy("")
    }
  }

  return (
    <section className="min-w-0 flex-[999_1_520px] rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <h3 className="text-base font-semibold text-slate-900">Payment</h3>
        <p className="text-sm text-slate-600">Pending <strong className="tabular-nums text-slate-900">{rs(data.balance)}</strong></p>
      </div>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Payment officer *">
            <select value={officerId} onChange={(e) => setOfficerId(e.target.value)} className={input} disabled={blocked}>
              <option value="">Select payment officer</option>
              {officers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Payment mode *">
            <div role="group" aria-label="Payment mode" className="flex h-10 gap-1 rounded-lg bg-slate-100 p-1">
              {MODES.map(([k, label]) => (
                <button key={k} type="button" disabled={blocked} aria-pressed={mode === k} onClick={() => setMode(k)} className={`flex-1 rounded-md text-sm font-semibold ${mode === k ? "bg-slate-900 text-white" : "text-slate-700"}`}>
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <Field label={mode === "cash" ? "Transaction ID / UTR (optional)" : "Transaction ID / UTR *"}>
            <input value={utr} onChange={(e) => setUtr(e.target.value)} className={`${input} font-mono`} disabled={blocked} placeholder={mode === "upi" ? "UPI reference no." : mode === "bank_transfer" ? "Bank UTR" : "Receipt no."} />
          </Field>
          <Field label="Payment date *">
            <input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} className={input} disabled={blocked} />
          </Field>
          <Field label={`Amount ₹ * (full or partial, up to ${rs(maxPay)})`}>
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" className={`${input} tabular-nums`} disabled={blocked} />
          </Field>
          <Field label="Note / hold reason">
            <input value={note} onChange={(e) => setNote(e.target.value)} className={input} placeholder="Optional" />
          </Field>
        </div>

        {confirm ? (
          <div className="space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3">
            <p className="text-sm text-emerald-950">
              Pay <strong>{rs(amt)}</strong> to <strong>{restaurantName}</strong> for {data.cycle.label} by {MODES.find((m) => m[0] === mode)?.[1]}
              {utr ? ` (${utr.trim()})` : ""}? This locks {data.lines.length} bill{data.lines.length === 1 ? "" : "s"} under <span className="font-mono">{data.settlementNo}</span>
              {amt < data.balance - 0.009 ? ` and leaves ${rs(data.balance - amt)} pending.` : "."}
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy === "pay"} onClick={pay} className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50">
                {busy === "pay" && <Loader2 className="h-4 w-4 animate-spin" />} Yes, record payment
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="h-10 rounded-lg px-4 text-sm text-slate-700 hover:bg-white">Back</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={blocked || !valid} onClick={() => setConfirm(true)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-700 px-5 text-sm font-semibold text-white disabled:opacity-40">
              <Lock className="h-4 w-4" /> Clear Payment
            </button>
            {!carried && (onHold ? (
              <button type="button" disabled={Boolean(busy)} onClick={() => hold(false)} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-800">
                <PlayCircle className="h-4 w-4" /> Release hold
              </button>
            ) : (
              <button type="button" disabled={Boolean(busy) || (!data.lines.length && !data.carriedIn)} onClick={() => hold(true)} className="inline-flex h-10 items-center gap-2 rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-800">
                <PauseCircle className="h-4 w-4" /> Put on hold
              </button>
            ))}
            {!blocked && !valid && <span className="text-xs text-slate-500">Fill officer, amount{mode === "cash" ? "" : ", UTR"} and date.</span>}
            {onHold && <span className="text-xs text-red-800">On hold: release the hold to pay.</span>}
            {carried && <span className="text-xs text-violet-800">The balance moved to {data.settlement.carriedTo}.</span>}
            {!onHold && !carried && data.balance <= 0 && data.lines.length > 0 && <span className="text-xs text-emerald-800">Fully paid.</span>}
          </div>
        )}
      </div>
    </section>
  )
}

const MODE_LABEL = Object.fromEntries(MODES)
function Payments({ payments }) {
  return (
    <section className="min-w-0 flex-[1_1_380px] rounded-xl border border-slate-200 bg-white">
      <h3 className="border-b border-slate-100 px-4 py-3 text-base font-semibold text-slate-900">Payment history</h3>
      {payments.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">No payments yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {payments.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-slate-900">{MODE_LABEL[p.mode] || p.mode}{p.utr ? <span className="ml-1 font-mono text-xs text-slate-600">{p.utr}</span> : ""}</p>
                <p className="text-xs text-slate-500">Paid {day(p.paidOn)} · officer {p.officerName || "—"} · entered by {p.recordedBy || "admin"}</p>
                {p.note && <p className="text-xs text-slate-500">{p.note}</p>}
              </div>
              <span className="shrink-0 font-semibold tabular-nums text-emerald-800">{rs(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function History({ rows, current, onOpen }) {
  if (!rows.length) return null
  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <h3 className="border-b border-slate-100 px-4 py-3 text-base font-semibold text-slate-900">Previous settlements</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2.5 font-medium">Settlement ID</th>
              <th className="px-4 py-2.5 font-medium">Period</th>
              <th className="px-4 py-2.5 text-right font-medium">Orders</th>
              <th className="px-4 py-2.5 text-right font-medium">Payable</th>
              <th className="px-4 py-2.5 text-right font-medium">Paid</th>
              <th className="px-4 py-2.5 text-right font-medium">Pending</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((h) => (
              <tr key={h.settlementNo} onClick={() => onOpen(h)} className={`cursor-pointer hover:bg-slate-50 ${`${h.year}-${String(h.month).padStart(2, "0")}-${h.cycle}` === current ? "bg-slate-50" : ""}`}>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-800"><button type="button" className="hover:underline">{h.settlementNo}</button></td>
                <td className="px-4 py-2.5 text-slate-700">{h.label}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{h.orders}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rs(h.payable + h.carriedIn)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rs(h.paid)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{h.carriedTo ? `→ ${h.carriedTo}` : rs(h.balance)}</td>
                <td className="px-4 py-2.5"><Pill status={h.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
