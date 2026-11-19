import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Pencil } from "lucide-react"
import { adminAPI } from "@food/api"
import apiClient from "@/services/api/axios"

/**
 * Change what a rider signed up as: section, services, vehicle type, name and
 * number (PATCH /food/admin/delivery/:id/vehicle).
 *
 * Mirrors DRIVER_INTENTS in Backend/src/modules/taxi/shared/driverClasses.js;
 * the server re-checks everything, including that the vehicle fits the section.
 * The vehicle list comes from the same endpoint the sign-up screen uses, so the
 * admin is offered exactly what a rider of that section could have picked.
 */
const SECTIONS = [
  {
    key: "two_wheeler",
    label: "2 wheeler",
    intents: [
      { key: "food_daily_medical_parcel", label: "Food + Daily needs + Medical + Bike parcel", caps: ["delivery", "quickCommerce", "parcel"] },
      { key: "bike_taxi_parcel", label: "Bike Taxi (passengers)", caps: ["taxi"] },
    ],
  },
  {
    key: "passenger_taxi",
    label: "Passenger taxi",
    intents: [
      { key: "three_wheeler", label: "3 wheeler", caps: ["taxi"] },
      { key: "four_wheeler", label: "4 wheeler", caps: ["taxi"] },
    ],
  },
  {
    key: "parcel_vehicle",
    label: "Vehicle for parcels",
    intents: [
      { key: "parcel_delivery", label: "Parcel delivery", caps: ["parcel"] },
      { key: "heavy_parcel_delivery", label: "Heavy delivery", caps: ["parcel"] },
    ],
  },
]
const CAP_LABEL = { delivery: "Food", quickCommerce: "Daily needs & Medical", parcel: "Parcel", taxi: "Passenger rides" }

const errText = (err, fallback) => err?.response?.data?.message || err?.response?.data?.error || fallback

export default function VehicleServicesEditor({ partner, onSaved }) {
  const [open, setOpen] = useState(false)
  const [driverClass, setDriverClass] = useState(partner?.driverClass || "two_wheeler")
  const [intents, setIntents] = useState(Array.isArray(partner?.serviceIntents) ? partner.serviceIntents : [])
  const [vehicleType, setVehicleType] = useState(partner?.vehicleType || "")
  const [vehicleName, setVehicleName] = useState(partner?.vehicleName || "")
  const [vehicleNumber, setVehicleNumber] = useState(partner?.vehicleNumber || "")
  const [vehicles, setVehicles] = useState([])
  const [loadingVehicles, setLoadingVehicles] = useState(false)
  const [saving, setSaving] = useState(false)

  const section = SECTIONS.find((s) => s.key === driverClass) || SECTIONS[0]
  const chosen = intents.filter((k) => section.intents.some((i) => i.key === k))
  const caps = useMemo(() => {
    const set = new Set()
    for (const i of section.intents) if (chosen.includes(i.key)) i.caps.forEach((c) => set.add(c))
    return [...set]
  }, [section, chosen])

  // Vehicles a rider of this section (and these services) may drive.
  useEffect(() => {
    if (!open) return
    let live = true
    setLoadingVehicles(true)
    apiClient
      .get("/food/delivery/onboarding/requirements", { params: { driverClass, intents: chosen.join(",") }, contextModule: "admin" })
      .then((res) => {
        if (!live) return
        const list = res?.data?.data?.vehicleTypes || []
        setVehicles(list)
        if (!list.some((v) => v.id === vehicleType)) setVehicleType(list[0]?.id || "")
      })
      .catch(() => live && setVehicles([]))
      .finally(() => live && setLoadingVehicles(false))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, driverClass, chosen.join(",")])

  const toggleIntent = (key) =>
    setIntents((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev.filter((k) => section.intents.some((i) => i.key === k)), key]))

  const save = async () => {
    if (!chosen.length) return toast.error("Tick at least one service")
    if (!vehicleType) return toast.error("Choose the vehicle type")
    setSaving(true)
    try {
      const res = await adminAPI.updateDeliveryPartnerVehicle(partner._id, {
        driverClass,
        serviceIntents: chosen,
        vehicleType,
        vehicleName,
        vehicleNumber,
        serviceCapabilities: caps,
      })
      const saved = res?.data?.data || {}
      toast.success("Vehicle and services updated")
      onSaved?.(saved)
      setOpen(false)
    } catch (err) {
      toast.error(errText(err, "Could not update the vehicle"))
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
      >
        <Pencil className="h-3.5 w-3.5" /> Edit vehicle & services
      </button>
    )
  }

  const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase text-slate-500">What the rider drives</p>
        <div className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => { setDriverClass(s.key); setIntents([s.intents[0].key]) }}
              className={`rounded-lg border px-3 py-1.5 text-sm ${driverClass === s.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase text-slate-500">Services</p>
        <div className="flex flex-wrap gap-2">
          {section.intents.map((i) => (
            <label key={i.key} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${chosen.includes(i.key) ? "border-emerald-600 bg-emerald-50 text-emerald-900" : "border-slate-300 bg-white text-slate-700"}`}>
              <input type="checkbox" className="accent-emerald-600" checked={chosen.includes(i.key)} onChange={() => toggleIntent(i.key)} />
              {i.label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Will take: {caps.length ? caps.map((c) => CAP_LABEL[c] || c).join(", ") : "nothing"}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="text-xs font-semibold uppercase text-slate-500">Vehicle type</span>
          <select className={`${inputCls} mt-1`} value={vehicleType} onChange={(e) => setVehicleType(e.target.value)} disabled={loadingVehicles}>
            {loadingVehicles && <option>Loading…</option>}
            {!loadingVehicles && vehicles.length === 0 && <option value="">No vehicle types for this</option>}
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase text-slate-500">Vehicle name</span>
          <input className={`${inputCls} mt-1`} value={vehicleName} onChange={(e) => setVehicleName(e.target.value)} placeholder="e.g. Splendor" />
        </label>
        <label className="block">
          <span className="text-xs font-semibold uppercase text-slate-500">Vehicle number</span>
          <input className={`${inputCls} mt-1`} value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())} placeholder="HP37C 8476" />
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || loadingVehicles}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
        </button>
      </div>
    </div>
  )
}
