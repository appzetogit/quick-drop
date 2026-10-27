import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, RefreshCw, Search, MapPin, Phone } from "lucide-react"
import { Loader } from "@googlemaps/js-api-loader"
import apiClient from "@food/api/axios"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"

/**
 * Master > Delivery Management > Live Drivers.
 *
 * Everyone online right now across food, quick and taxi, one row per person,
 * and where they are (core/delivery/liveRiders.js). Refreshes every 10 seconds.
 * A position older than the server's "fresh" window is shown as stale: the
 * app was likely closed without going offline.
 */

const REFRESH_MS = 10_000

const STATUS = {
  free: { label: "Free", pill: "bg-emerald-50 text-emerald-700", color: "#059669" },
  on_ride: { label: "On a ride", pill: "bg-sky-50 text-sky-700", color: "#0284c7" },
  on_delivery: { label: "On a delivery", pill: "bg-amber-50 text-amber-800", color: "#d97706" },
}
const STALE_COLOR = "#9ca3af"

const FILTERS = [
  { key: "all", label: "All online" },
  { key: "free", label: "Free" },
  { key: "on_ride", label: "On a ride" },
  { key: "on_delivery", label: "On a delivery" },
  { key: "stale", label: "Location stale" },
]

const ago = (iso) => {
  if (!iso) return "never"
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const serviceLabel = (services = []) =>
  services.length === 2 ? "Taxi + Delivery" : services[0] === "taxi" ? "Taxi" : services[0] === "delivery" ? "Delivery" : "—"

function Stat({ label, value, tone = "text-neutral-900", active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start rounded-lg border px-4 py-3 text-left transition-colors ${
        active ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 bg-white hover:border-neutral-400"
      }`}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{label}</span>
      <span className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</span>
    </button>
  )
}

export default function LiveDrivers() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [filter, setFilter] = useState("all")
  const [q, setQ] = useState("")
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [mapState, setMapState] = useState("loading") // loading | ready | nokey | error
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map())
  const infoRef = useRef(null)
  const fittedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get("/platform/live-riders", { contextModule: "admin" })
      setData(res?.data?.data || null)
      setError("")
    } catch (err) {
      setError(err?.response?.data?.message || "Could not load live drivers.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return undefined
    const t = setInterval(load, REFRESH_MS)
    return () => clearInterval(t)
  }, [autoRefresh, load])

  // Google Maps, once.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const apiKey = await getGoogleMapsApiKey()
        if (!apiKey && !window.google?.maps) {
          if (!cancelled) setMapState("nokey")
          return
        }
        const google = window.google?.maps ? window.google : await new Loader({ apiKey, version: "weekly", libraries: ["places", "geometry"] }).load()
        if (cancelled || !mapEl.current) return
        mapRef.current = new google.maps.Map(mapEl.current, {
          center: { lat: 32.1, lng: 76.5 },
          zoom: 10,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: true,
        })
        infoRef.current = new google.maps.InfoWindow()
        setMapState("ready")
      } catch {
        if (!cancelled) setMapState("error")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const riders = data?.riders || []
  const stats = data?.stats || {}

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return riders.filter((r) => {
      if (filter === "stale" && r.live) return false
      if (filter !== "all" && filter !== "stale" && r.status !== filter) return false
      if (!needle) return true
      return `${r.name} ${r.phone} ${r.vehicle}`.toLowerCase().includes(needle)
    })
  }, [riders, filter, q])

  // Markers follow the list: added, moved, recoloured, removed each refresh.
  useEffect(() => {
    const google = window.google
    const map = mapRef.current
    if (mapState !== "ready" || !map || !google?.maps) return
    const markers = markersRef.current
    const keep = new Set()
    for (const r of shown) {
      if (r.lat == null || r.lng == null) continue
      keep.add(r.id)
      const color = r.live ? (STATUS[r.status]?.color || STALE_COLOR) : STALE_COLOR
      const icon = {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: "#ffffff",
        strokeWeight: 2,
      }
      let m = markers.get(r.id)
      if (!m) {
        m = new google.maps.Marker({ map, position: { lat: r.lat, lng: r.lng }, icon, title: r.name })
        m.addListener("click", () => openInfo(m.__rider, m))
        markers.set(r.id, m)
      } else {
        m.setPosition({ lat: r.lat, lng: r.lng })
        m.setIcon(icon)
      }
      m.__rider = r
    }
    for (const [id, m] of markers) {
      if (!keep.has(id)) {
        m.setMap(null)
        markers.delete(id)
      }
    }
    // Frame everyone the first time there is someone to frame.
    if (!fittedRef.current && keep.size > 0) {
      const bounds = new google.maps.LatLngBounds()
      for (const id of keep) bounds.extend(markers.get(id).getPosition())
      map.fitBounds(bounds, 60)
      if (keep.size === 1) map.setZoom(14)
      fittedRef.current = true
    }
  }, [shown, mapState])

  const openInfo = (r, marker) => {
    if (!r || !infoRef.current) return
    const status = STATUS[r.status]?.label || r.status
    infoRef.current.setContent(
      `<div style="font:13px system-ui,sans-serif;min-width:170px">
        <div style="font-weight:600">${r.name.replace(/</g, "&lt;")}</div>
        <div style="color:#525252">${(r.phone || "").replace(/</g, "&lt;")}</div>
        <div style="margin-top:4px">${status} · ${serviceLabel(r.services)}</div>
        <div style="color:#737373">${r.live ? "Location" : "Last location"} ${ago(r.lastSeenAt)}</div>
      </div>`,
    )
    infoRef.current.open({ map: mapRef.current, anchor: marker })
  }

  const focus = (r) => {
    const m = markersRef.current.get(r.id)
    if (!m || !mapRef.current) return
    mapRef.current.panTo(m.getPosition())
    mapRef.current.setZoom(15)
    openInfo(r, m)
  }

  return (
    <div className="min-h-screen bg-neutral-50 p-4 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">Live Drivers</h1>
            <p className="text-sm text-neutral-500">
              Everyone online now across food, quick and taxi, and where they are. Updates every 10 seconds.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {data?.at && <span className="text-neutral-500">Updated {ago(data.at)}</span>}
            <label className="inline-flex items-center gap-1.5 text-neutral-700">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              Auto refresh
            </label>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 font-medium text-neutral-800 hover:bg-neutral-100"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Online" value={stats.online ?? "—"} active={filter === "all"} onClick={() => setFilter("all")} />
          <Stat label="Free" value={stats.free ?? "—"} tone="text-emerald-700" active={filter === "free"} onClick={() => setFilter("free")} />
          <Stat label="On a ride" value={stats.onRide ?? "—"} tone="text-sky-700" active={filter === "on_ride"} onClick={() => setFilter("on_ride")} />
          <Stat label="On a delivery" value={stats.onDelivery ?? "—"} tone="text-amber-700" active={filter === "on_delivery"} onClick={() => setFilter("on_delivery")} />
          <Stat label="Location stale" value={stats.stale ?? "—"} tone="text-neutral-500" active={filter === "stale"} onClick={() => setFilter("stale")} />
        </div>

        <div className="relative overflow-hidden rounded-lg border border-neutral-200 bg-white">
          <div ref={mapEl} className="h-[420px] w-full" />
          {mapState !== "ready" && (
            <div className="absolute inset-0 flex items-center justify-center bg-neutral-50 text-sm text-neutral-500">
              {mapState === "loading" ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : mapState === "nokey" ? (
                "No Google Maps key is set. Add it under Master Settings > Google Maps Key."
              ) : (
                "The map could not load. Check the Google Maps key."
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-4 border-t border-neutral-100 px-4 py-2 text-xs text-neutral-600">
            {Object.values(STATUS).map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: STALE_COLOR }} />
              Location older than {data?.freshMinutes ?? 10} min
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-neutral-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 p-3">
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    filter === f.key ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-neutral-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, phone or vehicle"
                className="w-full rounded-lg border border-neutral-300 py-2 pl-8 pr-3 text-sm"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-left text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-4 py-2.5">Driver</th>
                  <th className="px-4 py-2.5">Service</th>
                  <th className="px-4 py-2.5">Vehicle</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Location</th>
                  <th className="px-4 py-2.5">Last update</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-neutral-500">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </td>
                  </tr>
                ) : shown.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-neutral-500">
                      {riders.length === 0 ? "No driver is online right now." : "No driver matches this filter."}
                    </td>
                  </tr>
                ) : (
                  shown.map((r) => {
                    const s = STATUS[r.status] || { label: r.status, pill: "bg-neutral-100 text-neutral-700" }
                    const hasPoint = r.lat != null && r.lng != null
                    return (
                      <tr
                        key={r.id}
                        onClick={() => hasPoint && focus(r)}
                        className={`${hasPoint ? "cursor-pointer hover:bg-neutral-50" : ""}`}
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-neutral-900">{r.name}</div>
                          {r.phone && (
                            <a
                              href={`tel:${r.phone}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800"
                            >
                              <Phone className="h-3 w-3" />
                              {r.phone}
                            </a>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-neutral-700">{serviceLabel(r.services)}</td>
                        <td className="px-4 py-2.5 text-neutral-700">{r.vehicle || "—"}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${s.pill}`}>{s.label}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          {hasPoint ? (
                            <a
                              href={`https://www.google.com/maps?q=${r.lat},${r.lng}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-xs text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
                            >
                              <MapPin className="h-3 w-3" />
                              {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                            </a>
                          ) : (
                            <span className="text-xs text-neutral-400">No location yet</span>
                          )}
                        </td>
                        <td className={`px-4 py-2.5 text-xs tabular-nums ${r.live ? "text-neutral-700" : "text-neutral-400"}`}>
                          {ago(r.lastSeenAt)}
                          {!r.live && r.lastSeenAt && <span className="ml-1 rounded bg-neutral-100 px-1 py-0.5 text-[10px] text-neutral-500">stale</span>}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
