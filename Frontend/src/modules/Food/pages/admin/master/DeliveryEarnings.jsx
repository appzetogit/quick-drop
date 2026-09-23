import { useState, useEffect, useCallback } from "react"
import { platformSettingsAPI } from "@food/api"
import { toast } from "sonner"
import { Loader2, Plus, Trash2, RotateCcw, Bike, Gift } from "lucide-react"

/**
 * Master > Delivery earnings: what a rider is paid, set once.
 *
 * Two rules the screen exists to make visible.
 *
 * FIRST, empty means "not managed here". Until a table is saved, each module
 * keeps paying from its own screen exactly as it does today, and the header says
 * so rather than showing a blank table that looks like nobody is paid.
 *
 * SECOND, "for one module or all" is the override chain, not a copy: saving
 * under All modules sets the global table; saving under Food sets an override
 * that beats it for food only. Clearing the override drops back to global. The
 * server decides precedence (core/config/scope.js) -- this screen only shows
 * which level is in play.
 *
 * Editing starts from the module's OWN bands, ids included, because the per-band
 * admin delivery commission in fee settings is keyed by those ids. Building a
 * table by hand instead would silently unhook it.
 */

const SLAB_KEY = "earnings.distanceSlabs"
const INCENTIVE_KEY = "earnings.incentive"

const MODULES = [
  { id: "*", level: "global", label: "All modules", hint: "The table every module falls back to" },
  { id: "food", level: "vertical", label: "Food", hint: "Overrides the all-modules table for food" },
  { id: "quickCommerce", level: "vertical", label: "Quick Commerce", hint: "Overrides it for quick commerce" },
  { id: "medical", level: "vertical", label: "Medical", hint: "Overrides it for pharmacy orders" },
  /*
   * Taxi takes the incentive but not the table. A ride is priced by base fare,
   * per km and per minute from its vehicle's price row -- no delivery distance
   * band can express that, and pretending otherwise would let an admin save a
   * table that silently does nothing. The incentive is the same shape
   * everywhere, so that is the part taxi shares.
   */
  { id: "taxi", level: "vertical", label: "Taxi", hint: "Driver incentive only — ride fares are set in the Taxi panel", incentiveOnly: true },
]

/** Which module's figures to READ when showing "what is paid today". */
const readVertical = (moduleId) => (moduleId === "*" ? "food" : moduleId)

const inputCls =
  "w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm tabular-nums focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 disabled:bg-neutral-50"
const btnCls =
  "inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
const ghostCls =
  "inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"

const errText = (err, fallback) => err?.response?.data?.message || err?.message || fallback
const num = (v) => (v === "" || v === null || v === undefined ? "" : Number(v))

const emptyBand = () => ({
  distanceRuleId: null,
  name: "",
  minDistance: 0,
  maxDistance: null,
  userDeliveryFee: 0,
  commissionPerKm: 0,
  basePayout: 0,
  extraPerKm: 0,
})

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

/** Where the value in force came from, in words an operator can act on. */
function SourceLine({ level, source }) {
  const tone =
    level === "legacy" || level === null
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-emerald-50 text-emerald-800 border-emerald-200"
  return (
    <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${tone}`}>
      In force now: <span className="font-medium">{source}</span>
    </div>
  )
}

function BandRow({ band, onChange, onRemove, disabled }) {
  const set = (field) => (e) => {
    const raw = e.target.value
    onChange({ ...band, [field]: raw === "" ? (field === "maxDistance" ? null : 0) : Number(raw) })
  }
  return (
    <tr className="border-b border-neutral-100 last:border-0">
      <td className="py-2 pr-2">
        <input type="number" min="0" step="0.5" className={inputCls} value={num(band.minDistance)} onChange={set("minDistance")} disabled={disabled} />
      </td>
      <td className="py-2 pr-2">
        <input
          type="number"
          min="0"
          step="0.5"
          className={inputCls}
          value={band.maxDistance === null ? "" : num(band.maxDistance)}
          placeholder="No limit"
          onChange={set("maxDistance")}
          disabled={disabled}
        />
      </td>
      <td className="py-2 pr-2">
        <input type="number" min="0" step="1" className={inputCls} value={num(band.userDeliveryFee)} onChange={set("userDeliveryFee")} disabled={disabled} />
      </td>
      <td className="py-2 pr-2">
        <input type="number" min="0" step="1" className={inputCls} value={num(band.basePayout)} onChange={set("basePayout")} disabled={disabled} />
      </td>
      <td className="py-2 pr-2">
        <input type="number" min="0" step="1" className={inputCls} value={num(band.commissionPerKm)} onChange={set("commissionPerKm")} disabled={disabled} />
      </td>
      <td className="py-2 pr-2">
        <input type="number" min="0" step="1" className={inputCls} value={num(band.extraPerKm)} onChange={set("extraPerKm")} disabled={disabled} />
      </td>
      <td className="py-2 text-right">
        <button type="button" onClick={onRemove} disabled={disabled} className="rounded-lg p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label="Remove band">
          <Trash2 className="h-4 w-4" />
        </button>
      </td>
    </tr>
  )
}

export default function DeliveryEarnings() {
  const [moduleId, setModuleId] = useState("*")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState(null)
  const [bands, setBands] = useState([])
  const [incentive, setIncentive] = useState({ isEnabled: false, minOrderAmount: 0, incentivePercent: 0 })
  const [slabChain, setSlabChain] = useState(null)

  const mod = MODULES.find((m) => m.id === moduleId) || MODULES[0]

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const vertical = readVertical(moduleId)
      const [effective, chain] = await Promise.all([
        platformSettingsAPI.getEarnings(vertical),
        platformSettingsAPI.explain(SLAB_KEY, moduleId === "*" ? {} : { vertical: moduleId }),
      ])
      const d = effective?.data?.data
      setData(d)
      setSlabChain(chain?.data?.data || null)

      // The value saved AT THIS LEVEL, which is what the editor edits. A level
      // with nothing of its own opens on the module's current bands rather than
      // an empty table, so "save" never silently drops what is being paid now.
      const own = (chain?.data?.data?.chain || []).find((l) => l.level === mod.level && (mod.level === "global" || l.scopeId === moduleId))
      const savedHere = own?.set ? own.value : null
      setBands(savedHere?.length ? savedHere : d?.moduleBands?.length ? d.moduleBands : [])
      setIncentive({
        isEnabled: d?.incentive?.isEnabled === true,
        minOrderAmount: Number(d?.incentive?.minOrderAmount || 0),
        incentivePercent: Number(d?.incentive?.incentivePercent || 0),
      })
    } catch (err) {
      toast.error(errText(err, "Could not load delivery earnings"))
    } finally {
      setLoading(false)
    }
  }, [moduleId, mod.level])

  useEffect(() => {
    load()
  }, [load])

  const save = async (key, value, what) => {
    setSaving(true)
    try {
      await platformSettingsAPI.set(key, {
        level: mod.level,
        scopeId: mod.level === "global" ? "*" : moduleId,
        value,
      })
      toast.success(value === null ? `${what} cleared` : `${what} saved for ${mod.label}`)
      await load()
    } catch (err) {
      toast.error(errText(err, `Could not save ${what.toLowerCase()}`))
    } finally {
      setSaving(false)
    }
  }

  const savedAtThisLevel = (slabChain?.chain || []).some(
    (l) => l.level === mod.level && l.set && (mod.level === "global" || l.scopeId === moduleId),
  )

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900">Delivery earnings</h1>
          <p className="mt-1 text-sm text-neutral-600">What a rider is paid, set once for every module or overridden for one.</p>
        </div>

        <div className="space-y-5">
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-neutral-200 bg-white p-1">
        {MODULES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setModuleId(m.id)}
            className={`min-w-0 flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${moduleId === m.id ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="-mt-3 px-1 text-xs text-neutral-500">{mod.hint}</p>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading
        </div>
      ) : (
        <>
          {mod.incentiveOnly && (
            <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              A ride is priced by base fare, per km and per minute in the Taxi panel, so the
              distance table below does not apply here. The incentive does.
            </p>
          )}
          {!mod.incentiveOnly && (
          <Card
            title="Rider earning formula"
            icon={Bike}
            description="Each row is a distance band. A rider is paid the base payout plus the per-km rate for the band the trip falls in."
            footer={
              <>
                {savedAtThisLevel && (
                  <button type="button" className={ghostCls} disabled={saving} onClick={() => save(SLAB_KEY, null, "Earning formula")}>
                    <RotateCcw className="h-4 w-4" />
                    Clear {mod.level === "global" ? "global table" : "override"}
                  </button>
                )}
                <button type="button" className={ghostCls} disabled={saving || !data?.moduleBands?.length} onClick={() => setBands(data.moduleBands)}>
                  Start from current table
                </button>
                <button type="button" className={btnCls} disabled={saving || !bands.length} onClick={() => save(SLAB_KEY, bands, "Earning formula")}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save formula
                </button>
              </>
            }
          >
            <SourceLine level={data?.slabLevel} source={data?.slabSource} />

            {bands.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">
                No bands yet. Add one, or start from the module&apos;s current table.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                      <th className="pb-2 pr-2">From (km)</th>
                      <th className="pb-2 pr-2">To (km)</th>
                      <th className="pb-2 pr-2">Customer fee</th>
                      <th className="pb-2 pr-2">Base payout</th>
                      <th className="pb-2 pr-2">Per km</th>
                      <th className="pb-2 pr-2">Extra per km</th>
                      <th className="pb-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {bands.map((b, i) => (
                      <BandRow
                        key={i}
                        band={b}
                        disabled={saving}
                        onChange={(next) => setBands(bands.map((x, j) => (j === i ? next : x)))}
                        onRemove={() => setBands(bands.filter((_, j) => j !== i))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={ghostCls} disabled={saving} onClick={() => setBands([...bands, emptyBand()])}>
                <Plus className="h-4 w-4" />
                Add band
              </button>
            </div>

            <p className="mt-3 text-xs text-neutral-500">
              Leave <span className="font-medium">To (km)</span> empty on the last band to make it open ended, and
              give it an <span className="font-medium">Extra per km</span> so longer trips cost more. Without that,
              every trip past the final band is charged the same as one at its edge &mdash; and the rider is paid the
              same for it.
            </p>
          </Card>
          )}

          <Card
            title="Rider incentive"
            icon={Gift}
            description="An extra percentage of the order value, paid to the rider on orders at or above the minimum."
            footer={
              <>
                <button type="button" className={ghostCls} disabled={saving} onClick={() => save(INCENTIVE_KEY, null, "Incentive")}>
                  <RotateCcw className="h-4 w-4" />
                  Clear
                </button>
                <button type="button" className={btnCls} disabled={saving} onClick={() => save(INCENTIVE_KEY, incentive, "Incentive")}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save incentive
                </button>
              </>
            }
          >
            <SourceLine level={data?.incentive?.level} source={data?.incentive?.source} />
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="flex items-center gap-2 sm:col-span-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-neutral-300"
                  checked={incentive.isEnabled}
                  disabled={saving}
                  onChange={(e) => setIncentive({ ...incentive, isEnabled: e.target.checked })}
                />
                <span className="text-sm font-medium text-neutral-800">Pay an incentive on large orders</span>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-neutral-800">Minimum order value</span>
                <input
                  type="number"
                  min="0"
                  step="50"
                  className={`${inputCls} mt-1.5`}
                  value={num(incentive.minOrderAmount)}
                  disabled={saving || !incentive.isEnabled}
                  onChange={(e) => setIncentive({ ...incentive, minOrderAmount: Number(e.target.value || 0) })}
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-neutral-800">Incentive percent</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  className={`${inputCls} mt-1.5`}
                  value={num(incentive.incentivePercent)}
                  disabled={saving || !incentive.isEnabled}
                  onChange={(e) => setIncentive({ ...incentive, incentivePercent: Number(e.target.value || 0) })}
                />
              </label>
            </div>
          </Card>
        </>
      )}
        </div>
      </div>
    </div>
  )
}
