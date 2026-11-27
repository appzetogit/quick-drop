import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Plus, RefreshCw, Trash2, Pencil, LayoutGrid, Search, X } from "lucide-react"
import { homeSectionAPI } from "@food/api"

/**
 * Master > Home Sections: admin-curated chips on the food home, next to the
 * hardcoded Trending / 99 Store / Buy-1-Get-1 ones. Each section holds the
 * restaurants and dishes the admin picks, and (optionally) the zones it shows
 * in. Empty zones = every zone.
 */

const ICON_OPTIONS = [
  "offer", "fire", "gift", "star", "veg", "delivery", "rupee", "bolt", "heart", "cup",
]

const errText = (err, fb) => err?.response?.data?.message || fb

const blankForm = () => ({
  id: null,
  title: "",
  highlight: "",
  icon: "offer",
  bgColor: "",
  textColor: "",
  position: 0,
  status: "active",
  zoneIds: [],
  restaurantIds: [],
  itemIds: [],
})

export default function MasterHomeSections() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [zones, setZones] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [editing, setEditing] = useState(null) // form object or null
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await homeSectionAPI.list()
      setRows(res?.data?.data?.sections || [])
    } catch (err) {
      toast.error(errText(err, "Could not load sections"))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    homeSectionAPI.zones()
      .then((res) => setZones(Array.isArray(res?.data?.data) ? res.data.data : (res?.data?.data?.zones || [])))
      .catch(() => {})
    homeSectionAPI.restaurants()
      .then((res) => {
        const d = res?.data?.data
        const list = Array.isArray(d) ? d : (d?.restaurants || d?.data || [])
        setRestaurants(list.map((r) => ({ id: String(r.id || r._id), name: r.restaurantName || r.name || "Restaurant" })))
      })
      .catch(() => {})
  }, [])

  const openNew = () => setEditing(blankForm())
  const openEdit = (r) => setEditing({
    id: r.id,
    title: r.title || "",
    highlight: r.highlight || "",
    icon: r.icon || "offer",
    bgColor: r.bgColor || "",
    textColor: r.textColor || "",
    position: Number(r.position) || 0,
    status: r.status || "active",
    zoneIds: r.zoneIds || [],
    restaurantIds: r.restaurantIds || [],
    itemIds: r.itemIds || [],
  })

  const save = async () => {
    if (!editing.title.trim()) { toast.error("Title is required"); return }
    setSaving(true)
    try {
      const body = { ...editing, title: editing.title.trim() }
      if (editing.id) await homeSectionAPI.update(editing.id, body)
      else await homeSectionAPI.create(body)
      toast.success(editing.id ? "Section updated" : "Section created")
      setEditing(null)
      await load()
    } catch (err) {
      toast.error(errText(err, "Could not save section"))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (r) => {
    if (!window.confirm(`Delete section "${r.title}"?`)) return
    try {
      await homeSectionAPI.remove(r.id)
      toast.success("Section deleted")
      await load()
    } catch (err) {
      toast.error(errText(err, "Could not delete section"))
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-orange-600" />
          <h1 className="text-xl font-bold text-neutral-900">Home Sections</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={openNew} className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-sm font-semibold text-white hover:bg-orange-700">
            <Plus className="h-4 w-4" /> New section
          </button>
        </div>
      </div>

      <p className="text-sm text-neutral-500 mb-4">
        These chips appear on the food home after Trending / 99 Store / Buy-1-Get-1, in order of <b>position</b>. Tapping one opens its restaurants and dishes. Leave zones empty to show everywhere.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-neutral-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 py-16 text-center text-neutral-500">
          No sections yet. Click <b>New section</b> to create one.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-neutral-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Restaurants</th>
                <th className="px-4 py-2.5 font-medium">Dishes</th>
                <th className="px-4 py-2.5 font-medium">Zones</th>
                <th className="px-4 py-2.5 font-medium">Pos</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-2.5 font-semibold text-neutral-900">{r.title} {r.highlight && <span className="text-neutral-400 font-normal">{r.highlight}</span>}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{r.restaurantCount ?? (r.restaurantIds || []).length}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{r.itemCount ?? (r.itemIds || []).length}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{(r.zoneIds || []).length ? (r.zoneIds || []).length : "All"}</td>
                  <td className="px-4 py-2.5 text-neutral-600">{r.position}</td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${r.status === "active" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-neutral-100 text-neutral-500 ring-neutral-200"}`}>{r.status}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(r)} className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"><Pencil className="h-4 w-4" /></button>
                      <button onClick={() => remove(r)} className="rounded-md p-1.5 text-red-500 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <SectionForm
          value={editing}
          setValue={setEditing}
          zones={zones}
          restaurants={restaurants}
          onClose={() => setEditing(null)}
          onSave={save}
          saving={saving}
        />
      )}
    </div>
  )
}

function SectionForm({ value, setValue, zones, restaurants, onClose, onSave, saving }) {
  const set = (k, v) => setValue((f) => ({ ...f, [k]: v }))
  const toggleIn = (k, id) => setValue((f) => {
    const has = (f[k] || []).includes(id)
    return { ...f, [k]: has ? f[k].filter((x) => x !== id) : [...(f[k] || []), id] }
  })

  const [rSearch, setRSearch] = useState("")
  const filteredRestaurants = useMemo(() => {
    const q = rSearch.trim().toLowerCase()
    return q ? restaurants.filter((r) => r.name.toLowerCase().includes(q)) : restaurants
  }, [restaurants, rSearch])

  // Dishes are loaded from the selected restaurants' menus on demand.
  const [dishes, setDishes] = useState([]) // [{id, name, restaurantName}]
  const [loadingDishes, setLoadingDishes] = useState(false)
  const loadDishes = async () => {
    if (!value.restaurantIds.length) { toast.error("Pick at least one restaurant first"); return }
    setLoadingDishes(true)
    try {
      const { homeSectionAPI } = await import("@food/api")
      const all = []
      const seen = new Set()
      for (const rid of value.restaurantIds) {
        try {
          const res = await homeSectionAPI.menu(rid)
          const menu = res?.data?.data?.menu
          const rName = restaurants.find((x) => x.id === String(rid))?.name || ""
          // Flatten the grouped menu into a flat dish list.
          const flat = []
          if (menu && Array.isArray(menu.sections)) {
            for (const sec of menu.sections) {
              for (const it of (sec.items || [])) flat.push(it)
              for (const sub of (sec.subsections || [])) for (const it of (sub.items || [])) flat.push(it)
            }
          } else if (Array.isArray(menu)) {
            for (const it of menu) flat.push(it)
          }
          for (const it of flat) {
            const id = String(it.id || it._id || "")
            if (id && !seen.has(id)) {
              seen.add(id)
              all.push({ id, name: it.name || "Dish", restaurantName: rName })
            }
          }
        } catch { /* skip a restaurant whose menu failed */ }
      }
      setDishes(all)
      if (!all.length) toast.message("No dishes found for the selected restaurants")
    } finally {
      setLoadingDishes(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-neutral-900">{value.id ? "Edit section" : "New section"}</h2>
          <button onClick={onClose} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100"><X className="h-5 w-5" /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Title *"><input className={inp} value={value.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Festive Picks" /></Field>
          <Field label="Highlight (optional)"><input className={inp} value={value.highlight} onChange={(e) => set("highlight", e.target.value)} placeholder="e.g. Now" /></Field>
          <Field label="Icon">
            <select className={inp} value={value.icon} onChange={(e) => set("icon", e.target.value)}>
              {ICON_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>
          <Field label="Position">
            <input type="number" className={inp} value={value.position} onChange={(e) => set("position", Number(e.target.value) || 0)} />
          </Field>
        </div>

        <div className="mt-3 space-y-3">
          <ColorField label="Chip background (optional)" value={value.bgColor} onChange={(v) => set("bgColor", v)} />
          <ColorField label="Chip text color (optional)" value={value.textColor} onChange={(v) => set("textColor", v)} />
        </div>

        <div className="mt-3 flex items-center gap-2">
          <label className="text-sm font-medium text-neutral-700">Status</label>
          <button onClick={() => set("status", value.status === "active" ? "inactive" : "active")}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${value.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-neutral-200 text-neutral-600"}`}>
            {value.status}
          </button>
        </div>

        <Group title={`Zones (${value.zoneIds.length ? value.zoneIds.length + " selected" : "all zones"})`}>
          <div className="flex flex-wrap gap-2">
            {zones.length === 0 && <span className="text-xs text-neutral-400">No zones loaded.</span>}
            {zones.map((z) => {
              const id = String(z.id || z._id)
              const on = value.zoneIds.includes(id)
              return <Chip key={id} on={on} onClick={() => toggleIn("zoneIds", id)}>{z.name || z.zoneName || id}</Chip>
            })}
          </div>
        </Group>

        <Group title={`Restaurants (${value.restaurantIds.length} selected)`}>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-neutral-200 px-2">
            <Search className="h-4 w-4 text-neutral-400" />
            <input className="w-full py-1.5 text-sm outline-none" placeholder="Search restaurants" value={rSearch} onChange={(e) => setRSearch(e.target.value)} />
          </div>
          <div className="max-h-40 overflow-y-auto flex flex-wrap gap-2">
            {filteredRestaurants.map((r) => (
              <Chip key={r.id} on={value.restaurantIds.includes(r.id)} onClick={() => toggleIn("restaurantIds", r.id)}>{r.name}</Chip>
            ))}
          </div>
        </Group>

        <Group title={`Dishes (${value.itemIds.length} selected)`}>
          <button onClick={loadDishes} disabled={loadingDishes}
            className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50">
            {loadingDishes ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Load dishes from selected restaurants
          </button>
          <div className="max-h-40 overflow-y-auto flex flex-wrap gap-2">
            {dishes.length === 0 && <span className="text-xs text-neutral-400">Pick restaurants, then load their dishes to choose.</span>}
            {dishes.map((d) => (
              <Chip key={d.id} on={value.itemIds.includes(d.id)} onClick={() => toggleIn("itemIds", d.id)}>
                {d.name}{d.restaurantName ? <span className="text-neutral-400"> · {d.restaurantName}</span> : null}
              </Chip>
            ))}
          </div>
        </Group>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50">Cancel</button>
          <button onClick={onSave} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  )
}

const inp = "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-orange-400"

function Field({ label, children }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>{children}</label>
}

const PRESET_COLORS = [
  "#FFF0E6", "#FFF9E6", "#F3E5F5", "#E3F2FD", "#E8F5E9", "#E8F8F5", "#FDECEC", "#F5F5F5",
  "#FF7A00", "#F57F17", "#8E24AA", "#1976D2", "#2E7D32", "#00A86B", "#E53935", "#1E1E1E",
]

/** A visual colour picker: a native swatch picker + quick presets + a Default
 * (clear) choice. No hex typing needed; empty value = the chip's default look. */
function ColorField({ label, value, onChange }) {
  const current = (value || "").toUpperCase()
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-neutral-600">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={current || "#FF7A00"}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-9 w-10 shrink-0 cursor-pointer rounded-lg border border-neutral-200 bg-white p-1"
          title="Pick any colour"
        />
        <div className="flex flex-wrap gap-1.5">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              style={{ background: c }}
              title={c}
              className={`h-6 w-6 rounded-full ring-1 ring-inset ${current === c ? "ring-2 ring-orange-500 ring-offset-1" : "ring-neutral-300"}`}
            />
          ))}
        </div>
        {current ? (
          <button type="button" onClick={() => onChange("")} className="ml-auto shrink-0 text-xs font-medium text-neutral-500 hover:text-neutral-800">
            Default
          </button>
        ) : (
          <span className="ml-auto shrink-0 text-xs text-neutral-400">Default</span>
        )}
      </div>
    </div>
  )
}
function Group({ title, children }) {
  return <div className="mt-4"><div className="mb-2 text-sm font-semibold text-neutral-800">{title}</div>{children}</div>
}
function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${on ? "bg-orange-50 text-orange-700 ring-orange-300" : "bg-white text-neutral-600 ring-neutral-200 hover:bg-neutral-50"}`}>
      {children}
    </button>
  )
}
