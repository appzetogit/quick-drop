import { useState, useEffect, useCallback } from "react"
import { platformSettingsAPI } from "@food/api"
import { toast } from "sonner"
import { Loader2, ChevronDown, RotateCcw } from "lucide-react"

/**
 * Platform settings: the rules every service shares.
 *
 * One value per setting, set once. Where a service genuinely needs its own
 * number it is set under "Different for a service", and the row says which
 * services differ. City- and partner-level overrides still exist on the
 * server and still apply; they are set where those records are managed, not
 * by typing ids here.
 */

const SERVICES = [
  { key: "food", label: "Food" },
  { key: "quickCommerce", label: "Quick Commerce" },
  { key: "taxi", label: "Taxi" },
  { key: "serviceProvider", label: "Services" },
]

const AREA_LABELS = {
  finance: "Rider & partner money",
  assignment: "Order assignment",
  partner: "Partner rules",
  platform: "Platform",
}

const show = (v) => (v === null || v === undefined ? "Not set" : typeof v === "boolean" ? (v ? "On" : "Off") : String(v))
const valueAt = (setting, level) => (setting?.chain || []).find((l) => l.level === level)

function ValueInput({ type, value, onChange, disabled, placeholder, label }) {
  if (type === "boolean") {
    return (
      <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-neutral-100 p-0.5 text-sm">
        {[
          [true, "On"],
          [false, "Off"],
        ].map(([v, text]) => (
          <button
            key={text}
            type="button"
            role="radio"
            aria-checked={value === v}
            disabled={disabled}
            onClick={() => onChange(v)}
            className={`rounded-md px-3 py-1 font-medium ${value === v ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-800"}`}
          >
            {text}
          </button>
        ))}
      </div>
    )
  }
  return (
    <input
      type="number"
      aria-label={label}
      value={value === null || value === undefined ? "" : value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className="w-36 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm tabular-nums focus:border-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
    />
  )
}

function SettingCard({ setting, perService, onSaved }) {
  const globalLink = valueAt(setting, "global")
  const [value, setValue] = useState(globalLink?.set ? globalLink.value : null)
  const [overrides, setOverrides] = useState(() =>
    Object.fromEntries(SERVICES.map((s) => {
      const link = valueAt(perService[s.key], "vertical")
      return [s.key, link?.set ? link.value : null]
    })),
  )
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState("")

  const canPerService = (setting.scopes || []).includes("vertical")
  const differing = SERVICES.filter((s) => valueAt(perService[s.key], "vertical")?.set)
  const dirty = (globalLink?.set ? globalLink.value : null) !== value

  const save = async (level, scopeId, next, key) => {
    setBusy(key)
    try {
      await platformSettingsAPI.set(setting.key, { level, scopeId, value: next })
      toast.success(next === null ? "Now uses the platform value" : "Saved")
      onSaved()
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not save that setting")
    } finally {
      setBusy("")
    }
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-neutral-900">{setting.label}</p>
          {setting.help && <p className="mt-0.5 max-w-xl text-sm text-neutral-500">{setting.help}</p>}
          {differing.length > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              Different for {differing.map((s) => s.label).join(", ")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ValueInput type={setting.type} value={value} onChange={setValue} disabled={busy === "global"} placeholder="Not set" label={setting.label} />
          <button
            type="button"
            disabled={!dirty || busy === "global"}
            onClick={() => save("global", "*", value, "global")}
            className="inline-flex items-center gap-1 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:bg-neutral-200 disabled:text-neutral-500"
          >
            {busy === "global" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>

      {canPerService && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-xs font-medium text-neutral-600 hover:text-neutral-900"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            Different for a service
          </button>
          {open && (
            <div className="mt-2 grid gap-2 rounded-xl bg-neutral-50 p-3 sm:grid-cols-2">
              {SERVICES.map((s) => {
                const saved = valueAt(perService[s.key], "vertical")
                const current = overrides[s.key]
                const changed = (saved?.set ? saved.value : null) !== current
                return (
                  <div key={s.key} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-neutral-200">
                    <span className="text-sm text-neutral-800">{s.label}</span>
                    <div className="flex items-center gap-1.5">
                      <ValueInput
                        type={setting.type}
                        value={current}
                        label={`${setting.label} for ${s.label}`}
                        placeholder={`Same (${show(value)})`}
                        disabled={busy === s.key}
                        onChange={(v) => setOverrides((o) => ({ ...o, [s.key]: v }))}
                      />
                      {changed && (
                        <button
                          type="button"
                          onClick={() => save("vertical", s.key, current, s.key)}
                          className="rounded-md bg-neutral-900 px-2 py-1 text-xs font-semibold text-white"
                        >
                          Save
                        </button>
                      )}
                      {saved?.set && !changed && (
                        <button
                          type="button"
                          onClick={() => save("vertical", s.key, null, s.key)}
                          className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                          title="Use the platform value again"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export default function PlatformSettings() {
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState([])
  const [perService, setPerService] = useState({})
  const [catalogue, setCatalogue] = useState([])
  const [version, setVersion] = useState(0)

  const load = useCallback(async () => {
    try {
      const [cat, base, ...byService] = await Promise.all([
        platformSettingsAPI.getCatalogue(),
        platformSettingsAPI.resolveAll({}),
        ...SERVICES.map((s) => platformSettingsAPI.resolveAll({ vertical: s.key })),
      ])
      setCatalogue(cat?.data?.data?.areas || [])
      setSettings(base?.data?.data?.settings || [])
      const map = {}
      SERVICES.forEach((s, i) => {
        for (const row of byService[i]?.data?.data?.settings || []) {
          map[row.key] = { ...(map[row.key] || {}), [s.key]: row }
        }
      })
      setPerService(map)
      setVersion((v) => v + 1)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not load platform settings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const metaFor = (key) => {
    for (const area of catalogue) {
      const hit = (area.settings || []).find((s) => s.key === key)
      if (hit) return { scopes: hit.scopes, type: hit.type, area: area.area }
    }
    return { scopes: [], type: "number", area: "other" }
  }
  const areas = [...new Set(settings.map((s) => metaFor(s.key).area))]

  return (
    <div className="min-h-full bg-neutral-100 p-4 lg:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-neutral-900">Platform settings</h1>
            <p className="mt-1 text-sm text-neutral-600">
              Rules shared by Food, Quick Commerce, Taxi and Services. Set a value once; change it for one service only if that service really differs.
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await platformSettingsAPI.invalidateCache()
                toast.success("Settings reloaded")
                load()
              } catch {
                toast.error("Could not reload settings")
              }
            }}
            className="inline-flex items-center gap-1.5 self-start rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
            title="Use this if a change does not seem to apply"
          >
            <RotateCcw className="h-4 w-4" /> Reload settings
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-10 text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading settings
          </div>
        ) : (
          areas.map((area) => (
            <section key={area} className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
              <h2 className="border-b border-neutral-200 bg-neutral-50 px-5 py-2.5 text-sm font-semibold text-neutral-800">
                {AREA_LABELS[area] || area}
              </h2>
              <ul className="divide-y divide-neutral-100">
                {settings
                  .filter((s) => metaFor(s.key).area === area)
                  .map((s) => (
                    <SettingCard
                      key={`${s.key}-${version}`}
                      setting={{ ...s, ...metaFor(s.key) }}
                      perService={perService[s.key] || {}}
                      onSaved={load}
                    />
                  ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
