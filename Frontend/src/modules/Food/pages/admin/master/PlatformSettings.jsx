import { useState, useEffect, useCallback } from "react"
import { platformSettingsAPI } from "@food/api"
import { Button } from "@food/components/ui/button"
import { Input } from "@food/components/ui/input"
import { Label } from "@food/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@food/components/ui/card"
import { toast } from "sonner"
import { Loader2, Save, RotateCcw, Globe, Building2, MapPin, User, Info } from "lucide-react"

/**
 * Master / Global Settings.
 *
 * The screen the configuration hierarchy exists for. A rule that applies across
 * verticals is set ONCE here, and the override chain is shown rather than hidden --
 * because the question an operator actually arrives with is not "what is the cash
 * limit" but "why is it 1500 for this driver when I set 2000".
 *
 * Deliberately NOT built the way the rest of this panel handles verticals. The other
 * admin screens are one set of components re-pointed per vertical by rewriting URLs
 * and substituting words in the menu. That is fine for screens that genuinely exist
 * once per vertical; it would be wrong here, because this screen is not per-vertical
 * at all. It lives at /admin/master, outside the /admin/food base that
 * rebaseAdminMenu rewrites, so it appears identically from every panel and edits the
 * same values from each.
 */

const LEVEL_META = {
  global: { label: "Global default", icon: Globe, hint: "Applies everywhere unless something below overrides it" },
  vertical: { label: "Vertical override", icon: Building2, hint: "Food, quick commerce, taxi or service provider" },
  zone: { label: "City / zone override", icon: MapPin, hint: "A city or delivery zone" },
  partner: { label: "Partner override", icon: User, hint: "One specific partner" },
}

const AREA_LABELS = {
  finance: "Partner money",
  assignment: "Assignment",
  partner: "Partner rules",
  platform: "Platform",
}

/** Renders the value editor appropriate to the setting's declared type. */
function ValueEditor({ setting, value, onChange, disabled }) {
  if (setting.type === "boolean") {
    return (
      <select
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value === "" || value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}
        disabled={disabled}
      >
        <option value="">Not set at this level</option>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    )
  }

  return (
    <Input
      type="number"
      value={value === null || value === undefined ? "" : value}
      placeholder="Not set at this level"
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      disabled={disabled}
    />
  )
}

/**
 * One setting: what it resolves to, where that came from, and every level beneath.
 *
 * The chain is the whole point of the component. Showing only the effective value
 * would make this a settings screen like any other, and leave the operator to work
 * out which of four possible levels they are actually looking at.
 */
function SettingRow({ setting, context, onSaved }) {
  const [draft, setDraft] = useState(null)
  const [editingLevel, setEditingLevel] = useState(null)
  const [saving, setSaving] = useState(false)

  const scopeIdFor = (level) => {
    if (level === "global") return "*"
    if (level === "vertical") return context.vertical
    if (level === "zone") return context.zoneId
    if (level === "partner") return context.partnerId
    return ""
  }

  const startEdit = (level, currentValue) => {
    setEditingLevel(level)
    setDraft(currentValue === undefined ? null : currentValue)
  }

  const save = async () => {
    const scopeId = scopeIdFor(editingLevel)
    if (editingLevel !== "global" && !scopeId) {
      // Without an id the write has nowhere to land, and the server would refuse it
      // anyway -- saying so here avoids a round trip to be told the obvious.
      toast.error(`Choose a ${editingLevel} above before setting an override for it`)
      return
    }
    setSaving(true)
    try {
      const res = await platformSettingsAPI.set(setting.key, {
        level: editingLevel,
        scopeId,
        value: draft,
      })
      // `null` clears the override rather than storing a null, so the setting falls
      // back to whatever is underneath it.
      toast.success(draft === null ? "Override cleared" : "Saved")
      setEditingLevel(null)
      onSaved(setting.key, res?.data?.data || res?.data)
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not save that setting")
    } finally {
      setSaving(false)
    }
  }

  const effectiveDisplay =
    setting.effective === null || setting.effective === undefined
      ? "not set"
      : typeof setting.effective === "boolean"
        ? setting.effective ? "On" : "Off"
        : String(setting.effective)

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{setting.label}</div>
          {setting.help ? (
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{setting.help}</p>
          ) : null}
          <code className="text-xs text-muted-foreground">{setting.key}</code>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-semibold">{effectiveDisplay}</div>
          {/* The provenance. "Effective 1500" alone is a number somebody then has to
              go hunting to justify. */}
          <div className="text-xs text-muted-foreground">{setting.source}</div>
        </div>
      </div>

      <div className="grid gap-2">
        {(setting.chain || []).map((link) => {
          const meta = LEVEL_META[link.level] || { label: link.level, icon: Info }
          const Icon = meta.icon
          const allowed = (setting.scopes || []).includes(link.level)
          const isEditing = editingLevel === link.level

          return (
            <div
              key={link.level}
              className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                link.effective ? "border-primary bg-primary/5" : "border-transparent bg-muted/40"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="w-40 shrink-0">{meta.label}</span>

              {!allowed ? (
                <span className="text-muted-foreground italic">
                  not overridable at this level
                </span>
              ) : isEditing ? (
                <>
                  <div className="w-48">
                    <ValueEditor
                      setting={setting}
                      value={draft}
                      onChange={setDraft}
                      disabled={saving}
                    />
                  </div>
                  <Button size="sm" onClick={save} disabled={saving}>
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    <span className="ml-1">Save</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingLevel(null)} disabled={saving}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <span className={link.set ? "font-medium" : "text-muted-foreground"}>
                    {link.set
                      ? typeof link.value === "boolean"
                        ? link.value ? "On" : "Off"
                        : String(link.value)
                      : "—"}
                  </span>
                  {link.effective ? (
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">in effect</span>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => startEdit(link.level, link.value)}
                  >
                    {link.set ? "Change" : "Set"}
                  </Button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function PlatformSettings() {
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState([])
  const [catalogue, setCatalogue] = useState([])
  const [context, setContext] = useState({ vertical: "", zoneId: "", partnerId: "" })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cat, resolved] = await Promise.all([
        platformSettingsAPI.getCatalogue(),
        platformSettingsAPI.resolveAll(context),
      ])
      setCatalogue(cat?.data?.data?.areas || [])
      setSettings(resolved?.data?.data?.settings || [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Could not load platform settings")
    } finally {
      setLoading(false)
    }
  }, [context])

  useEffect(() => {
    load()
  }, [load])

  const onSaved = (key, detail) => {
    if (!detail) return load()
    setSettings((prev) => prev.map((s) => (s.key === key ? { ...s, ...detail } : s)))
  }

  /** The catalogue carries which levels each key may be set at; the resolver carries
   *  the values. Joined here so a row has both without a second request per key. */
  const scopesFor = (key) => {
    for (const area of catalogue) {
      const hit = (area.settings || []).find((s) => s.key === key)
      if (hit) return { scopes: hit.scopes, type: hit.type, area: area.area }
    }
    return { scopes: [], type: "number", area: "other" }
  }

  const areas = [...new Set(settings.map((s) => scopesFor(s.key).area))]

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Master settings</h1>
        <p className="text-muted-foreground">
          Rules that apply across food, quick commerce, taxi and service provider. Set once here;
          override below only where a vertical, a city or a partner genuinely differs.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resolve for</CardTitle>
          <CardDescription>
            Leave blank to see the global picture. Fill these in to ask what a setting resolves to
            for a particular vertical, city or partner — the chain below updates to match.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <Label>Vertical</Label>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={context.vertical}
              onChange={(e) => setContext((c) => ({ ...c, vertical: e.target.value }))}
            >
              <option value="">— none —</option>
              <option value="food">Food</option>
              <option value="quickCommerce">Quick commerce</option>
              <option value="taxi">Taxi</option>
              <option value="serviceProvider">Service provider</option>
            </select>
          </div>
          <div>
            <Label>Zone / city id</Label>
            <Input
              value={context.zoneId}
              placeholder="e.g. a zone id"
              onChange={(e) => setContext((c) => ({ ...c, zoneId: e.target.value }))}
            />
          </div>
          <div>
            <Label>Partner id</Label>
            <Input
              value={context.partnerId}
              placeholder="e.g. a driver id"
              onChange={(e) => setContext((c) => ({ ...c, partnerId: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
        </div>
      ) : (
        areas.map((area) => (
          <Card key={area}>
            <CardHeader>
              <CardTitle className="text-base">{AREA_LABELS[area] || area}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {settings
                .filter((s) => scopesFor(s.key).area === area)
                .map((s) => (
                  <SettingRow
                    key={s.key}
                    setting={{ ...s, ...scopesFor(s.key) }}
                    context={context}
                    onSaved={onSaved}
                  />
                ))}
            </CardContent>
          </Card>
        ))
      )}

      <div className="flex justify-end">
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await platformSettingsAPI.invalidateCache()
              toast.success("Cache cleared on this instance")
              load()
            } catch {
              toast.error("Could not clear the cache")
            }
          }}
        >
          <RotateCcw className="h-4 w-4 mr-1" />
          Clear settings cache
        </Button>
      </div>
    </div>
  )
}
