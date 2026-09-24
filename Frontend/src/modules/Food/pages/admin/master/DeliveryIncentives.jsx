import { useState, useEffect, useCallback } from "react"
import { incentiveRulesAPI } from "@food/api"
import { toast } from "sonner"
import { Loader2, Target, History, Plus, Trash2 } from "lucide-react"

/**
 * Master > Delivery Incentives: an order-count LADDER per duty segment —
 * "1-5 orders → ₹100, 5-10 → ₹150, 10-15 → ₹200" — not a single target.
 * Each rung pays independently the moment a rider reaches it, on top of
 * whatever earlier rungs already paid that day.
 *
 * Two segments, not per-module tabs like Delivery Earnings — a rider works
 * one of two duty segments at a time (the Flutter app's DutySegment), and
 * both food+quick-commerce+medical riders and taxi+porter riders share one
 * ladder within their segment. Saving inserts a new active rule and
 * deactivates whichever was active for that segment before it (server-side,
 * see incentiveRule.model.js) — this screen never edits a rule in place, so
 * "recent" below is real history, not a log of the same document changing.
 */

const SEGMENTS = [
  {
    id: "foodAndQuick",
    label: "Food, Quick Commerce & Medical",
    hint: "Riders on the food-and-delivery duty — food, groceries and medicine all count toward the same ladder.",
  },
  {
    id: "taxiAndPorter",
    label: "Taxi & Porter",
    hint: "Riders on the rides-and-parcel duty — rides and parcel/porter jobs both count toward the same ladder.",
  },
]

const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm tabular-nums focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:bg-neutral-50"
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
const ghostCls =
  "inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"

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

const emptyTier = (fromOrders = 1, toOrders = 5, rewardAmount = 100) => ({ fromOrders, toOrders, rewardAmount })

/** Next row starts right after the previous one's "to", so the ladder reads
 *  continuously (1-5, 5-10, 10-15, ...) by default — the admin can still
 *  edit either boundary afterward. */
const nextTierAfter = (tiers) => {
  const last = tiers[tiers.length - 1]
  const from = last ? last.toOrders : 0
  return emptyTier(from, from + 5, 0)
}

const tiersFromRule = (rule) =>
  Array.isArray(rule?.tiers) && rule.tiers.length
    ? rule.tiers.map((t) => ({ fromOrders: t.fromOrders, toOrders: t.toOrders, rewardAmount: t.rewardAmount }))
    : [emptyTier()]

const emptyForm = () => ({ title: "", tiers: [emptyTier()] })

/** Null when every tier is individually valid and the ladder is in order;
 *  otherwise the reason, so the save button can stay disabled with a hint
 *  rather than letting an invalid ladder reach the server. */
function tiersError(tiers) {
  if (!tiers.length) return "Add at least one tier"
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i]
    if (!(Number(t.fromOrders) >= 1)) return `Tier ${i + 1}: "from" must be at least 1`
    if (!(Number(t.toOrders) >= Number(t.fromOrders))) return `Tier ${i + 1}: "to" must be at or above "from"`
    if (t.rewardAmount === "" || Number(t.rewardAmount) < 0) return `Tier ${i + 1}: reward can't be negative`
    if (i > 0 && Number(t.toOrders) <= Number(tiers[i - 1].toOrders)) {
      return `Tier ${i + 1}: "to" must be higher than the tier before it`
    }
  }
  return null
}

function TierRow({ tier, onChange, onRemove, disabled }) {
  const set = (field) => (e) => {
    const raw = e.target.value
    onChange({ ...tier, [field]: raw === "" ? "" : Number(raw) })
  }
  return (
    <tr className="border-b border-neutral-100 last:border-0">
      <td className="py-2 pr-2">
        <input type="number" min="1" step="1" className={inputCls} value={tier.fromOrders} onChange={set("fromOrders")} disabled={disabled} />
      </td>
      <td className="py-2 pr-2">
        <input type="number" min="1" step="1" className={inputCls} value={tier.toOrders} onChange={set("toOrders")} disabled={disabled} />
      </td>
      <td className="py-2 pr-2">
        <input type="number" min="0" step="10" className={inputCls} value={tier.rewardAmount} onChange={set("rewardAmount")} disabled={disabled} />
      </td>
      <td className="py-2 text-right">
        <button type="button" onClick={onRemove} disabled={disabled} className="rounded-lg p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label="Remove tier">
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

function SegmentCard({ segment, active, saving, onSave }) {
  const [form, setForm] = useState(() => ({ title: active?.title || "", tiers: tiersFromRule(active) }))

  // Re-seed the form whenever the active rule for THIS segment changes (a
  // fresh load, or this segment's own save completing) — but never while the
  // admin is mid-edit on the other segment's card, since each card owns its
  // own independent form state.
  useEffect(() => {
    setForm({ title: active?.title || "", tiers: tiersFromRule(active) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?._id])

  const invalidReason = tiersError(form.tiers)
  const dirty =
    !active ||
    form.title !== (active.title || "") ||
    JSON.stringify(form.tiers) !== JSON.stringify(tiersFromRule(active))
  const finalTier = form.tiers[form.tiers.length - 1]
  const totalReward = form.tiers.reduce((sum, t) => sum + (Number(t.rewardAmount) || 0), 0)

  return (
    <Card
      title={segment.label}
      description={segment.hint}
      icon={Target}
      footer={
        <>
          {invalidReason && <span className="mr-auto text-xs text-red-600">{invalidReason}</span>}
          <button
            type="button"
            className={btnCls}
            disabled={saving || !dirty || Boolean(invalidReason)}
            onClick={() => onSave(segment.id, form)}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {active ? "Save new ladder" : "Turn on"}
          </button>
        </>
      }
    >
      {active ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Live now: {(active.tiers || []).map((t) => `${t.fromOrders}-${t.toOrders} → ₹${t.rewardAmount}`).join(",  ")}
          {active.title ? <> — &ldquo;{active.title}&rdquo;</> : null}
        </div>
      ) : (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Nothing active for this segment — riders see no incentive card until one is turned on.
        </div>
      )}

      <label className="mb-4 block">
        <span className="text-sm font-medium text-neutral-800">Headline (optional)</span>
        <input
          type="text"
          placeholder={finalTier ? `Complete ${finalTier.toOrders} orders, get up to ₹${totalReward}` : "Complete orders, get more"}
          className={`${inputCls} mt-1.5`}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
        <span className="mt-1 block text-xs text-neutral-500">
          Shown to the rider as-is. Left blank, the app fills in the numbers below.
        </span>
      </label>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
              <th className="pb-2 pr-2">From (orders)</th>
              <th className="pb-2 pr-2">To (orders)</th>
              <th className="pb-2 pr-2">Reward (₹)</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {form.tiers.map((t, i) => (
              <TierRow
                key={i}
                tier={t}
                disabled={saving}
                onChange={(next) => setForm({ ...form, tiers: form.tiers.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => setForm({ ...form, tiers: form.tiers.filter((_, j) => j !== i) })}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ghostCls}
          disabled={saving}
          onClick={() => setForm({ ...form, tiers: [...form.tiers, nextTierAfter(form.tiers)] })}
        >
          <Plus className="h-4 w-4" />
          Add tier
        </button>
        {finalTier && !invalidReason && (
          <span className="text-xs text-neutral-500">
            Ladder totals ₹{totalReward} if a rider reaches all {form.tiers.length} tier{form.tiers.length === 1 ? "" : "s"} ({finalTier.toOrders} orders).
          </span>
        )}
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
        tiers: form.tiers.map((t) => ({
          fromOrders: Number(t.fromOrders),
          toOrders: Number(t.toOrders),
          rewardAmount: Number(t.rewardAmount),
        })),
      })
      toast.success(`Incentive ladder saved for ${SEGMENTS.find((s) => s.id === segmentId)?.label || segmentId}`)
      await load()
    } catch (err) {
      toast.error(errText(err, "Could not save the incentive ladder"))
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
            An order-count ladder per duty segment — e.g. 1-5 orders → ₹100, 5-10 → ₹150, 10-15 → ₹200. Each tier
            credits the rider's wallet automatically the moment they reach it; the rider app shows live progress up
            the ladder.
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
              <Card title="Recent ladders" description="Every version saved for either segment, newest first." icon={History}>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                        <th className="pb-2 pr-2">Segment</th>
                        <th className="pb-2 pr-2">Tiers</th>
                        <th className="pb-2 pr-2">Status</th>
                        <th className="pb-2">Saved</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.map((r) => (
                        <tr key={r._id} className="border-b border-neutral-100 last:border-0">
                          <td className="py-2 pr-2 align-top">{SEGMENTS.find((s) => s.id === r.segment)?.label || r.segment}</td>
                          <td className="py-2 pr-2">
                            {(r.tiers || []).map((t) => `${t.fromOrders}-${t.toOrders} → ₹${t.rewardAmount}`).join(",  ")}
                          </td>
                          <td className="py-2 pr-2 align-top">
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
                          <td className="py-2 align-top text-neutral-500">
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
