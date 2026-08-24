import { useEffect, useState } from "react"
import { Eye, EyeOff, Loader2, MapPin, Save } from "lucide-react"
import { Button } from "@food/components/ui/button"
import { adminAPI } from "@food/api"
import { toast } from "sonner"

/**
 * Google Maps key for the whole platform.
 *
 * Saved on the shared settings document and served to every frontend (user,
 * restaurant, delivery, admin) through /api/v1/env/public, so changing it here
 * takes effect on the next page load with no rebuild or redeploy.
 */
export default function MapSettings() {
  const [apiKey, setApiKey] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await adminAPI.getMapSettings()
        setApiKey(response?.data?.data?.googleMapsApiKey || "")
      } catch (error) {
        toast.error("Failed to load map settings")
      } finally {
        setLoading(false)
      }
    }
    fetchSettings()
  }, [])

  const handleSave = async () => {
    try {
      setSaving(true)
      const response = await adminAPI.updateMapSettings({ googleMapsApiKey: apiKey.trim() })
      if (response?.data?.success) {
        toast.success("Google Maps key saved — reload any open app to pick it up")
      } else {
        toast.error(response?.data?.message || "Failed to save map settings")
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Failed to save map settings")
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100">
          <MapPin className="h-5 w-5 text-slate-700" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Google Maps</h1>
          <p className="text-sm text-slate-500">
            One key, used by the customer, restaurant, delivery and admin apps.
          </p>
        </div>
      </div>

      <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Maps JavaScript API key
          </label>
          <div className="relative">
            <input
              type={revealed ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="AIza..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-slate-300 px-4 py-2.5 pr-11 font-mono text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              aria-label={revealed ? "Hide key" : "Show key"}
            >
              {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Needs Maps JavaScript API, Places API and Geocoding API enabled. This key
            ships to browsers, so restrict it by HTTP referrer in the Google Cloud
            console.
          </p>
        </div>

        <p className="rounded-xl bg-slate-50 p-4 text-xs text-slate-600">
          Leave blank to fall back to the key baked into the server environment.
          Address pickers, live tracking and route maps all read this value.
        </p>

        <div className="flex justify-end border-t border-slate-100 pt-4">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {saving ? "Saving..." : "Save key"}
          </Button>
        </div>
      </div>
    </div>
  )
}
