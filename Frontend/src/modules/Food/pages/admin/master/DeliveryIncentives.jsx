import { useState, useEffect, useCallback } from "react"
import { incentiveRulesAPI } from "@food/api"
import { toast } from "sonner"
import { Loader2, Target, History } from "lucide-react"

/**
 * Master > Delivery Incentives: "complete N orders today, get ₹X", set per
 * duty segment.
 *
 * Two segments, not per-module tabs like Delivery Earnings — a rider works
 * one of two duty segments at a time (the Flutter app's DutySegment), and
 * both food+quick-commerce+medical riders and taxi+porter riders share one
 * target within their segment. Saving inserts a new active rule and
 * deactivates whichever was active for that segment before it (server-side,
 * see incentiveRule.model.js) — this screen never edits a rule in place, so
 * "recent" below is real history, not a log of the same document changing.
 */

const SEGMENTS = [
  {
    id: "foodAndQuick",
    label: "Food, Quick Commerce & Medical",
    hint: "Riders on the food-and-delivery duty — food, groceries and medicine all count toward the same target.",
  },
  {
    id: "taxiAndPorter",
    label: "Taxi & Porter",
    hint: "Riders on the rides-and-parcel duty — rides and parcel/porter jobs both count toward the same target.",
  },
]

const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm tabular-nums focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:bg-neutral-50"
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"

const errText = (err, fallback) => err?.response?.data?.message || err?.message || fallback

function Card({ title, description, icon: Icon, children, footer }) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="flex items-start gap-3 border-b border-neutral-100 px-5 py-4">
        {Icon && <Icon className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400" />}
        <div className="min-w-0">
          <h2 className="font-semibold text-neutral-900">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-neutral-500">{description}</p>}
        </div>
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-100 bg-neutral-50 px-5 py-3">
          {footer}
        </div>
      )}
    </section>
  )
}

const emptyForm = () => ({ title: "", targetOrders: 5, rewardAmount: 100 })

function SegmentCard({ segment, active, saving, onSave }) {
  const [form, setForm] = useState(() =>
    active
      ? { title: active.title || "", targetOrders: active.targetOrders, rewardAmount: active.rewardAmount }
      : emptyForm(),
  )

  // Re-seed the form whenever the active rule for THIS segment changes (a
  // fresh load, or this segment's own save completing) — but never while the
  // admin is mid-edit on the other segment's card, since each card owns its
  // own independent form state.
  useEffect(() => {
    setForm(
      active
        ? { title: active.title || "", targetOrders: active.targetOrders, rewardAmount: active.rewardAmount }
        : emptyForm(),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?._id])

  const dirty =
    !active ||
    form.title !== (active.title || "") ||
    Number(form.targetOrders) !== active.targetOrders ||
    Number(form.rewardAmount) !== active.rewardAmount

  return (
    <Card
      title={segment.label}
      description={segment.hint}
      icon={Target}
      footer={
        <button
          type="button"
          className={btnCls}
          disabled={saving || !dirty || !form.targetOrders || form.rewardAmount === ""}
          onClick={() => onSave(segment.id, form)}
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {active ? "Save new target" : "Turn on"}
        </button>
      }
    >
      {active ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Live now: complete <span className="font-medium">{active.targetOrders}</span> orders, get{" "}
          <span className="font-medium">₹{active.rewardAmount}</span>
          {active.title ? <> — &ldquo;{active.title}&rdquo;</> : null}
        </div>
      ) : (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Nothing active for this segment — riders see no incentive card until one is turned on.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="text-sm font-medium text-neutral-800">Headline (optional)</span>
          <input
            type="text"
            placeholder={`Complete ${form.targetOrders || 5} orders, get ₹${form.rewardAmount || 100}`}
            className={`${inputCls} mt-1.5`}
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <span className="mt-1 block text-xs text-neutral-500">
            Shown to the rider as-is. Left blank, the app fills in the numbers below.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-neutral-800">Orders to complete (today)</span>
          <input
            type="number"
            min="1"
            step="1"
            className={`${inputCls} mt-1.5`}
            value={form.targetOrders}
            onChange={(e) => setForm({ ...form, targetOrders: e.target.value === "" ? "" : Number(e.target.value) })}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-neutral-800">Reward (₹)</span>
          <input
            type="number"
            min="0"
            step="10"
            className={`${inputCls} mt-1.5`}
            value={form.rewardAmount}
            onChange={(e) => setForm({ ...form, rewardAmount: e.target.value === "" ? "" : Number(e.target.value) })}
          />
        </label>
      </div>
    </Card>
  )
}

export default function DeliveryIncentives() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(null) // segment id currently saving, or null
  const [active, setActive] = useState([])
  const [recent, setRecent] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await incentiveRulesAPI.list()
      const data = res?.data?.data || {}
      setActive(Array.isArray(data.active) ? data.active : [])
      setRecent(Array.isArray(data.recent) ? data.recent : [])
    } catch (err) {
      toast.error(errText(err, "Could not load incentive rules"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const activeFor = (segmentId) => active.find((r) => r.segment === segmentId) || null

  const save = async (segmentId, form) => {
    setSaving(segmentId)
    try {
      await incentiveRulesAPI.upsert({
        segment: segmentId,
        title: form.title,
        targetOrders: Number(form.targetOrders),
        rewardAmount: Number(form.rewardAmount),
      })
      toast.success(`Incentive saved for ${SEGMENTS.find((s) => s.id === segmentId)?.label || segmentId}`)
      await load()
    } catch (err) {
      toast.error(errText(err, "Could not save the incentive rule"))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Delivery incentives</h1>
          <p className="mt-1 text-sm text-neutral-600">
            "Complete N orders today, get ₹X" — set per duty segment. Reaching the target credits the reward to the
            rider's wallet automatically; the rider app shows live progress toward it.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading
          </div>
        ) : (
          <>
            <div className="space-y-5">
              {SEGMENTS.map((segment) => (
                <SegmentCard
                  key={segment.id}
                  segment={segment}
                  active={activeFor(segment.id)}
                  saving={saving === segment.id}
                  onSave={save}
                />
              ))}
            </div>

            {recent.length > 0 && (
              <Card title="Recent rules" description="Every version saved for either segment, newest first." icon={History}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                        <th className="pb-2 pr-2">Segment</th>
                        <th className="pb-2 pr-2">Target</th>
                        <th className="pb-2 pr-2">Reward</th>
                        <th className="pb-2 pr-2">Status</th>
                        <th className="pb-2">Saved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r) => (
                        <tr key={r._id} className="border-b border-neutral-100 last:border-0">
                          <td className="py-2 pr-2">{SEGMENTS.find((s) => s.id === r.segment)?.label || r.segment}</td>
                          <td className="py-2 pr-2">{r.targetOrders} orders</td>
                          <td className="py-2 pr-2">₹{r.rewardAmount}</td>
                          <td className="py-2 pr-2">
                            {r.isActive ? (
                              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                Active
                              </span>
                            ) : (
                              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
                                Retired
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-neutral-500">
                            {r.createdAt ? new Date(r.createdAt).toLocaleString() : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  )
}
