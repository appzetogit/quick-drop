import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import Lenis from "lenis"
import { ArrowLeft, Search, Check } from "lucide-react"
import { restaurantAPI } from "@food/api"

const CUISINES_STORAGE_KEY = "restaurant_cuisines"

const ALL_CUISINES = [
  "Burger",
  "Chinese",
  "Momos",
  "North Indian",
  "Pizza",
  "Rolls",
  "Sandwich",
  "Shawarma",
  "South Indian",
  "Biryani",
  "Desserts",
  "Ice Cream",
  "Fast Food",
  "Cafe",
  "Italian",
  "Mexican",
  "Thai",
  "Seafood",
  "Salad",
  "Healthy Food",
  "Juices",
  "Beverages",
  "Punjabi",
  "Gujarati",
  "Rajasthani",
  "Mughlai",
  "Street Food",
  "Bakery",
]

const DEFAULT_SELECTED = [
  "Burger",
  "Chinese",
  "Momos",
  "North Indian",
  "Pizza",
  "Rolls",
  "Sandwich",
  "Shawarma",
]

export default function EditCuisines() {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  // Fetch current cuisines from backend
  useEffect(() => {
    const fetchCuisines = async () => {
      try {
        setLoading(true)
        const response = await restaurantAPI.getCurrentRestaurant()
        const data = response?.data?.data?.restaurant || response?.data?.restaurant
        if (data?.cuisines && Array.isArray(data.cuisines) && data.cuisines.length > 0) {
          setSelected(data.cuisines)
        } else {
          // Fallback to localStorage
          try {
            const saved = localStorage.getItem(CUISINES_STORAGE_KEY)
            if (saved) {
              const parsed = JSON.parse(saved)
              if (Array.isArray(parsed) && parsed.length) {
                setSelected(parsed)
              } else {
                setSelected(DEFAULT_SELECTED)
              }
            } else {
              setSelected(DEFAULT_SELECTED)
            }
          } catch (e) {
            console.error("Error loading cuisines from localStorage:", e)
            setSelected(DEFAULT_SELECTED)
          }
        }
      } catch (error) {
        console.error("Error fetching cuisines:", error)
        // Fallback to localStorage
        try {
          const saved = localStorage.getItem(CUISINES_STORAGE_KEY)
          if (saved) {
            const parsed = JSON.parse(saved)
            if (Array.isArray(parsed) && parsed.length) {
              setSelected(parsed)
            } else {
              setSelected(DEFAULT_SELECTED)
            }
          } else {
            setSelected(DEFAULT_SELECTED)
          }
        } catch (e) {
          console.error("Error loading cuisines from localStorage:", e)
          setSelected(DEFAULT_SELECTED)
        }
      } finally {
        setLoading(false)
      }
    }

    fetchCuisines()
  }, [])

  // Lenis smooth scrolling
  useEffect(() => {
    const lenis = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    })

    function raf(time) {
      lenis.raf(time)
      requestAnimationFrame(raf)
    }

    requestAnimationFrame(raf)

    return () => {
      lenis.destroy()
    }
  }, [])

  const handleToggle = (name) => {
    const isSelected = selected.includes(name)
    if (!isSelected && selected.length >= 8) {
      setError("You cannot select more than 8 cuisines")
      // Hide after a short delay
      setTimeout(() => setError(""), 2500)
      return
    }
    setSelected((prev) =>
      isSelected ? prev.filter((c) => c !== name) : [...prev, name]
    )
  }

  const handleUpdate = async () => {
    try {
      // Save to backend API
      const response = await restaurantAPI.updateProfile({ cuisines: selected })
      
      if (response?.data?.data?.restaurant) {
        // Also save to localStorage as backup
        try {
          localStorage.setItem(CUISINES_STORAGE_KEY, JSON.stringify(selected))
          window.dispatchEvent(new Event("cuisinesUpdated"))
        } catch (e) {
          console.error("Error saving cuisines to localStorage:", e)
        }
        navigate(-1)
      } else {
        throw new Error("Invalid response from server")
      }
    } catch (error) {
      console.error("Error updating cuisines:", error)
      alert(`Failed to update cuisines: ${error.response?.data?.message || error.message || "Please try again."}`)
    }
  }

  const filtered = ALL_CUISINES.filter((name) =>
    name.toLowerCase().includes(search.toLowerCase())
  )

  const recommendedSet = new Set(DEFAULT_SELECTED)

  return (
    <div className="min-h-screen bg-neutral-50/60 pb-28 text-gray-900">
      {/* Header */}
      <div className="bg-white/95 backdrop-blur-md border-b border-gray-200 sticky top-0 z-30">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate(-1)}
              className="p-2 -ml-2 hover:bg-gray-100 rounded-xl text-gray-600 hover:text-gray-900 transition-colors"
              aria-label="Go back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-gray-900">Edit Restaurant Cuisines</h1>
              <p className="text-xs text-gray-500">
                Select up to 8 cuisines that best describe your menu.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleUpdate}
            disabled={selected.length === 0}
            className={`hidden sm:inline-flex items-center justify-center px-6 py-2 rounded-xl text-sm font-semibold transition-all shadow-sm ${
              selected.length === 0
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-gray-900 hover:bg-black text-white"
            }`}
          >
            Update Cuisines ({selected.length}/8)
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Search */}
        <div className="relative">
          <span className="absolute inset-y-0 left-3.5 flex items-center text-gray-400 pointer-events-none">
            <Search className="w-4 h-4" />
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all cuisines..."
            className="w-full h-11 pl-10 pr-4 rounded-xl border border-gray-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900 shadow-sm"
          />
        </div>

        {/* Selected count info banner */}
        <div className="flex items-center justify-between bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div>
            <p className="text-sm font-bold text-gray-900">Selected Cuisines: {selected.length}/8</p>
            <p className="text-xs text-gray-500">Cuisines determine which categories customers find your outlet under.</p>
          </div>
          {selected.length > 0 && (
            <button
              onClick={() => setSelected([])}
              className="text-xs font-semibold text-red-600 hover:underline"
            >
              Clear All
            </button>
          )}
        </div>

        {/* Recommended block */}
        <div className="bg-blue-50/80 border border-blue-200/80 rounded-2xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-900">Popular & Pre-Approved</p>
              <p className="text-xs text-gray-600">
                These cuisines update instantly without secondary moderation.
              </p>
            </div>
            <span className="text-[10px] font-bold tracking-wider text-emerald-700 bg-emerald-100 border border-emerald-300 px-2 py-0.5 rounded-full uppercase">
              Instant
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pt-1">
            {filtered
              .filter((name) => recommendedSet.has(name))
              .map((name) => {
                const isSelected = selected.includes(name)
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => handleToggle(name)}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                      isSelected
                        ? "bg-white border-blue-600 shadow-sm ring-1 ring-blue-600"
                        : "bg-white/80 border-blue-100 hover:bg-white hover:border-blue-300"
                    }`}
                  >
                    <span className="text-sm font-semibold text-gray-900">{name}</span>
                    <span
                      className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors ${
                        isSelected ? "bg-blue-600 text-white" : "border border-gray-300 bg-white"
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5" />}
                    </span>
                  </button>
                )
              })}
          </div>
        </div>

        {/* Other cuisines */}
        <div className="bg-white rounded-2xl border border-gray-200 p-5 shadow-sm space-y-3">
          <div>
            <p className="text-sm font-bold text-gray-900">All Other Cuisines</p>
            <p className="text-xs text-gray-500">Select any additional specialties your restaurant serves.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pt-1">
            {filtered
              .filter((name) => !recommendedSet.has(name))
              .map((name) => {
                const isSelected = selected.includes(name)
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => handleToggle(name)}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                      isSelected
                        ? "bg-gray-50 border-gray-900 shadow-sm ring-1 ring-gray-900"
                        : "bg-white border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    <span className="text-sm font-semibold text-gray-900">{name}</span>
                    <span
                      className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors ${
                        isSelected ? "bg-gray-900 text-white" : "border border-gray-300 bg-white"
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5" />}
                    </span>
                  </button>
                )
              })}
          </div>
        </div>
      </div>

      {/* Error bubble */}
      {error && (
        <div className="fixed left-1/2 bottom-24 -translate-x-1/2 bg-gray-900 text-white rounded-full shadow-2xl px-5 py-2 text-xs font-semibold z-50 animate-bounce">
          {error}
        </div>
      )}

      {/* Update button - Responsive Bottom Bar */}
      <div className="fixed lg:sticky bottom-0 left-0 right-0 bg-white/95 backdrop-blur-md border-t border-gray-200 px-4 py-3.5 z-30 shadow-lg lg:shadow-none">
        <div className="max-w-4xl mx-auto flex justify-end">
          <button
            type="button"
            onClick={handleUpdate}
            disabled={selected.length === 0}
            className={`w-full sm:w-auto px-8 py-2.5 rounded-xl text-sm font-bold transition-all ${
              selected.length === 0
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-gray-900 hover:bg-black text-white shadow-md hover:shadow-lg"
            }`}
          >
            Update Cuisines ({selected.length}/8)
          </button>
        </div>
      </div>
    </div>
  )
}
