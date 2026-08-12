import { useState, useRef, useEffect } from "react";
import { Info, Phone, Upload, X, Loader2, Globe, Settings, Car, UtensilsCrossed, Truck, Save, Trash2, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { adminAPI } from "@food/api";
import { setCachedSettings, updateFavicon, updateTitle } from "@food/utils/businessSettings";
import taxiAPI from "../../../../Taxi/shared/api/axiosInstance";
import { useSettings } from "../../../../Taxi/shared/context/SettingsContext";
import apiClient from "../../../../../services/api/axios";

const debugLog = (...args) => {}
const debugWarn = (...args) => {}
const debugError = (...args) => {}

const MODULE_METADATA = {
  landing: {
    label: "Landing Website",
    description: "Branding for the master home page and informational sections.",
    icon: Globe,
    colorClass: "text-sky-500 bg-sky-50",
    logos: [
      { key: "landing", label: "Landing Page Logo", description: "Main logo shown on the landing website header/footer." },
      { key: "landing_user", label: "User Portal Logo", description: "Logo for the main customer web portal and landing page users." }
    ]
  },
  admin: {
    label: "Admin Control Panels",
    description: "Branding for the global administration interface sidebars.",
    icon: Settings,
    colorClass: "text-indigo-500 bg-indigo-50",
    logos: [
      { key: "admin", label: "Admin Dashboard Logo", description: "Logo shown on admin control panels." }
    ]
  },
  taxi: {
    label: "Taxi / Rides App",
    description: "Branding for cab booking, taxi tracking, and driver portals.",
    icon: Car,
    colorClass: "text-amber-500 bg-amber-50",
    logos: [
      { key: "taxi", label: "Taxi Passenger Logo", description: "Logo shown to passengers booking taxi rides." },
      { key: "taxi_driver", label: "Taxi Driver Logo", description: "Logo shown to taxi drivers in driver-specific screens." }
    ]
  },
  food: {
    label: "Food Delivery App",
    description: "Branding for restaurant order tracking, user carts, and checkout.",
    icon: UtensilsCrossed,
    colorClass: "text-rose-500 bg-rose-50",
    logos: [
      { key: "food", label: "Restaurant App Logo", description: "Logo shown to customers." },
      { key: "food_restaurant", label: "Restaurant Owner Logo", description: "Logo shown on restaurant owner dashboards." },
      { key: "food_delivery_partner", label: "Food Delivery Partner Logo", description: "Logo shown on delivery partner portals." }
    ]
  },
  delivery: {
    label: "Delivery Logistics App",
    description: "Branding for parcel cargo onboarding and delivery agent portals.",
    icon: Truck,
    colorClass: "text-emerald-500 bg-emerald-50",
    logos: [
      { key: "delivery", label: "Logistics Client Logo", description: "Logo shown to customers sending/tracking shipments." },
      { key: "delivery_partner", label: "Logistics Partner Logo", description: "Logo shown to cargo/delivery agents." }
    ]
  }
};


export default function BusinessSetup() {
  const { refreshSettings } = useSettings();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    companyName: "",
    email: "",
    phoneCountryCode: "+91",
    phoneNumber: "",
    address: "",
    state: "",
    pincode: "",
    region: "",
  });

  const [taxiLogos, setTaxiLogos] = useState({ logos: {}, favicons: {} });
  const [logoSettingsLoading, setLogoSettingsLoading] = useState(true);
  const [savingLogoSettings, setSavingLogoSettings] = useState(false);
  const [logoUploading, setLogoUploading] = useState({});

  // Fetch business settings on mount
  useEffect(() => {
    fetchBusinessSettings();
    fetchTaxiBrandingSettings();
  }, []);

  const fetchBusinessSettings = async () => {
    try {
      setLoading(true);
      const response = await adminAPI.getBusinessSettings();
      const settings = response?.data?.data || response?.data;

      if (settings) {
        setFormData({
          companyName: settings.companyName || "",
          email: settings.email || "",
          phoneCountryCode: settings.phone?.countryCode || "+91",
          phoneNumber: settings.phone?.number || "",
          address: settings.address || "",
          state: settings.state || "",
          pincode: settings.pincode || "",
          region: settings.region || "India",
        });
      }
    } catch (error) {
      debugError("Error fetching business settings:", error);
      toast.error(error?.response?.data?.message || "Failed to load business settings");
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSave = async () => {
    try {
      // Validate required fields
      if (!formData.companyName.trim()) {
        toast.error("Company name is required");
        return;
      }
      if (formData.companyName.trim().length < 2) {
        toast.error("Company name must be at least 2 characters long");
        return;
      }

      if (!formData.email.trim()) {
        toast.error("Email is required");
        return;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.email.trim())) {
        toast.error("Please enter a valid email address");
        return;
      }

      if (!formData.phoneNumber.trim()) {
        toast.error("Phone number is required");
        return;
      }
      const phoneRegex = /^\d{7,15}$/;
      if (!phoneRegex.test(formData.phoneNumber.trim())) {
        toast.error("Please enter a valid phone number (7-15 digits)");
        return;
      }

      if (formData.pincode.trim() && !/^\d{4,10}$/.test(formData.pincode.trim())) {
        toast.error("Please enter a valid pincode (4-10 digits)");
        return;
      }

      setSaving(true);

      // Prepare form data
      const dataToSend = {
        companyName: formData.companyName.trim(),
        email: formData.email.trim(),
        phoneCountryCode: formData.phoneCountryCode,
        phoneNumber: formData.phoneNumber.trim(),
        address: formData.address.trim(),
        state: formData.state.trim(),
        pincode: formData.pincode.trim(),
        region: formData.region,
      };

      const files = {};
      if (logoFile) {
        files.logo = logoFile;
        files.favicon = logoFile;
      }
      if (restaurantLogoFile) {
        files.restaurantLogo = restaurantLogoFile;
      }
      if (deliveryPartnerLogoFile) {
        files.deliveryPartnerLogo = deliveryPartnerLogoFile;
      }

      const response = await adminAPI.updateBusinessSettings(dataToSend);
      const updatedSettings = response?.data?.data || response?.data;

      if (updatedSettings) {
        // Update global cache immediately
        setCachedSettings(updatedSettings);
      }

      toast.success("Business settings saved successfully");

      // Dispatch custom event to notify other components (like Sidebar)
      window.dispatchEvent(new CustomEvent('businessSettingsUpdated'));
    } catch (error) {
      debugError("Error saving business settings:", error);
      toast.error(error?.response?.data?.message || "Failed to save business settings");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    fetchBusinessSettings();
    toast.info("Form reset to saved values");
  };

  const fetchTaxiBrandingSettings = async () => {
    try {
      setLogoSettingsLoading(true);
      const res = await taxiAPI.get('/admin/general-settings/customize');
      const customizationData = res.data?.settings || {};
      setTaxiLogos({
        logos: customizationData.logos || {},
        favicons: customizationData.favicons || {}
      });
    } catch (err) {
      console.error('Failed to load branding configurations:', err);
    } finally {
      setLogoSettingsLoading(false);
    }
  };

  const handleTaxiLogoChange = (key, type, value) => {
    setTaxiLogos(prev => ({
      ...prev,
      [type === 'logo' ? 'logos' : 'favicons']: {
        ...prev[type === 'logo' ? 'logos' : 'favicons'],
        [key]: value
      }
    }));
  };

  const handleTaxiFileUpload = async (e, key, type) => {
    const file = e.target.files[0];
    if (!file) return;

    const isValidFormat = file.type === 'image/svg+xml' || file.type.startsWith('image/');
    if (!isValidFormat) {
      toast.error('Invalid file format. Please upload an image or SVG file.');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const uploadKey = `${key}_${type}`;
    setLogoUploading(prev => ({ ...prev, [uploadKey]: true }));

    try {
      const res = await apiClient.post('/uploads/image', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      const url = res?.data?.data?.url || res?.data?.url || res?.url;
      if (url) {
        handleTaxiLogoChange(key, type, url);
        toast.success(`${type === 'logo' ? 'Logo' : 'Favicon'} uploaded successfully!`);
      } else {
        toast.error('Upload failed. No URL returned.');
      }
    } catch (err) {
      console.error('Upload error:', err);
      toast.error('Failed to upload file');
    } finally {
      setLogoUploading(prev => ({ ...prev, [uploadKey]: false }));
    }
  };

  const handleSaveTaxiLogos = async () => {
    try {
      setSavingLogoSettings(true);
      const res = await taxiAPI.get('/admin/general-settings/customize');
      const currentCustomization = res.data?.settings || {};

      const updatedCustomization = {
        ...currentCustomization,
        logos: taxiLogos.logos,
        favicons: taxiLogos.favicons
      };

      await taxiAPI.patch('/admin/general-settings/customize', { settings: updatedCustomization });
      toast.success('Branding settings updated successfully!');
      refreshSettings();
    } catch (err) {
      console.error('Update error:', err);
      toast.error('Failed to save branding configurations');
    } finally {
      setSavingLogoSettings(false);
    }
  };


  if (loading) {
    return (
      <div className="p-4 lg:p-6 bg-slate-50 min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      {/* Page header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-slate-900">Business setup</h1>
          <p className="text-xs lg:text-sm text-slate-500 mt-1">
            Manage your company information, general configuration and business rules.
          </p>
        </div>

        {/* Note card (top-right) */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3 max-w-md">
          <div className="mt-0.5">
            <Info className="w-4 h-4 text-amber-500" />
          </div>
          <div className="text-xs lg:text-sm text-slate-700">
            <p className="font-semibold text-amber-700 mb-0.5">Note</p>
            <p>Don&apos;t forget to click the &quot;Save Information&quot; button below to save changes.</p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        {/* Company info */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200">
          {/* Company information */}
          <div className="px-4 py-4 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2">
              <span>Company Information</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Company name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Enter Your Company Name"
                  value={formData.companyName}
                  maxLength={50}
                  onChange={(e) => handleInputChange("companyName", e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  placeholder="Enter Your Email"
                  value={formData.email}
                  maxLength={100}
                  onChange={(e) => handleInputChange("email", e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Region <span className="text-red-500">*</span>
                </label>
                <select
                  value={formData.region}
                  onChange={(e) => handleInputChange("region", e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="India">India</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Phone <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-2">
                  <div className="relative w-32">
                    <select
                      value={formData.phoneCountryCode}
                      onChange={(e) => handleInputChange("phoneCountryCode", e.target.value)}
                      className="w-full pl-8 pr-6 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none"
                    >
                      <option value="+91">+91 (IN)</option>
                    </select>
                    <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 pointer-events-none">
                      ?
                    </span>
                  </div>
                  <input
                    type="text"
                    placeholder="Enter Your Phone Number"
                    value={formData.phoneNumber}
                    maxLength={15}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "");
                      handleInputChange("phoneNumber", val);
                    }}
                    className="flex-1 px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Address
                </label>
                <textarea
                  rows={2}
                  placeholder="Enter Your Addresss"
                  value={formData.address}
                  maxLength={250}
                  onChange={(e) => handleInputChange("address", e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  State
                </label>
                <input
                  type="text"
                  placeholder="Enter Your State"
                  value={formData.state}
                  maxLength={50}
                  onChange={(e) => handleInputChange("state", e.target.value)}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Pincode
                </label>
                <input
                  type="text"
                  placeholder="Enter Your Pincode"
                  value={formData.pincode}
                  maxLength={10}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, "");
                    handleInputChange("pincode", val);
                  }}
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

          </div>

          {/* Save Button Section */}
          <div className="px-4 py-4 border-t border-slate-100">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-[11px] text-slate-500">
                Changes will only be applied after clicking the <span className="font-semibold">Save Information</span> button.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {saving ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Information"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Dynamic Module-Specific branding */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-4 lg:p-6 mt-6">
          <div className="border-b border-slate-100 pb-4 mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ImageIcon size={18} className="text-blue-600 animate-pulse" />
              <h2 className="text-sm font-semibold text-slate-900">Module-Specific Branding Logos</h2>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Dynamic Setup</span>
          </div>

          {logoSettingsLoading ? (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
              <p className="text-xs text-slate-400 uppercase tracking-wider">Loading branding parameters...</p>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(MODULE_METADATA).map(([key, meta]) => {
                const IconComponent = meta.icon;
                const faviconUrl = taxiLogos.favicons[key] || '';
                
                return (
                  <div key={key} className="border border-slate-100 rounded-xl p-4 hover:shadow-sm transition-all duration-300">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 pb-3 border-b border-slate-100">
                      <div className="flex items-center gap-2.5">
                        <div className="p-2 rounded-lg bg-slate-100 text-slate-600 shrink-0">
                          <IconComponent size={18} />
                        </div>
                        <div>
                          <h4 className="text-[13px] font-bold text-slate-800">{meta.label}</h4>
                          <p className="text-[10px] text-slate-400 mt-0.5">{meta.description}</p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {/* Sub-Logos Section */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {meta.logos.map((logoMeta) => {
                          const logoUrl = taxiLogos.logos[logoMeta.key] || '';
                          return (
                            <div key={logoMeta.key} className="bg-slate-50 rounded-xl p-3.5 border border-slate-100 flex flex-col justify-between">
                              <div className="mb-2">
                                <span className="text-[11px] font-bold text-slate-700">{logoMeta.label}</span>
                                <p className="text-[9px] text-slate-400 mt-0.5">{logoMeta.description}</p>
                              </div>

                              <div className="flex items-center gap-3 mt-2">
                                {/* Logo Preview */}
                                <div className="h-14 w-20 rounded-lg border border-slate-200 bg-white p-1.5 flex items-center justify-center overflow-hidden shrink-0">
                                  {logoUrl ? (
                                    <img src={logoUrl} alt={logoMeta.label} className="max-h-full max-w-full object-contain" />
                                  ) : (
                                    <div className="text-center">
                                      <ImageIcon className="w-4 h-4 mx-auto text-slate-300" />
                                      <span className="text-[8px] text-slate-400 block mt-0.5">No Logo</span>
                                    </div>
                                  )}
                                </div>

                                {/* Actions */}
                                <div className="flex-1 flex gap-1.5">
                                  <label className={`flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg border border-blue-600/20 bg-blue-50/50 hover:bg-blue-50 text-blue-600 text-[10px] font-semibold cursor-pointer transition-all active:scale-95 ${
                                    logoUploading[`${logoMeta.key}_logo`] ? 'opacity-50 pointer-events-none' : ''
                                  }`}>
                                    {logoUploading[`${logoMeta.key}_logo`] ? (
                                      <Loader2 size={11} className="animate-spin" />
                                    ) : (
                                      <Upload size={11} />
                                    )}
                                    Upload
                                    <input 
                                      type="file" 
                                      accept="image/svg+xml,image/*" 
                                      onChange={(e) => handleTaxiFileUpload(e, logoMeta.key, 'logo')} 
                                      className="hidden" 
                                    />
                                  </label>

                                  {logoUrl && (
                                    <button
                                      type="button"
                                      onClick={() => handleTaxiLogoChange(logoMeta.key, 'logo', '')}
                                      className="p-1.5 rounded-lg border border-red-100 text-red-500 hover:bg-red-50 transition-all"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Favicon Upload */}
                      <div className="bg-slate-50 rounded-xl p-3.5 border border-slate-100">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] font-bold text-slate-600">Module Favicon</span>
                          <span className="text-[8px] text-slate-400">SVG/ICO, 1:1 ratio</span>
                        </div>

                        <div className="flex items-center gap-3">
                          {/* Favicon Preview */}
                          <div className="h-12 w-12 rounded-lg border border-slate-200 bg-white p-1.5 flex items-center justify-center overflow-hidden shrink-0">
                            {faviconUrl ? (
                              <img src={faviconUrl} alt="Favicon" className="h-6 w-6 object-contain" />
                            ) : (
                              <div className="text-center">
                                <ImageIcon className="w-4 h-4 mx-auto text-slate-300" />
                                <span className="text-[8px] text-slate-400 block mt-0.5">None</span>
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex-1 flex gap-1.5">
                            <label className={`flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg border border-blue-600/20 bg-blue-50/50 hover:bg-blue-50 text-blue-600 text-[10px] font-semibold cursor-pointer transition-all active:scale-95 ${
                              logoUploading[`${key}_favicon`] ? 'opacity-50 pointer-events-none' : ''
                            }`}>
                              {logoUploading[`${key}_favicon`] ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <Upload size={11} />
                              )}
                              Upload Favicon
                              <input 
                                type="file" 
                                accept="image/svg+xml,image/x-icon,image/png,image/jpeg" 
                                onChange={(e) => handleTaxiFileUpload(e, key, 'favicon')} 
                                className="hidden" 
                              />
                            </label>

                            {faviconUrl && (
                              <button
                                type="button"
                                onClick={() => handleTaxiLogoChange(key, 'favicon', '')}
                                className="p-1.5 rounded-lg border border-red-100 text-red-500 hover:bg-red-50 transition-all"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Action Bar */}
              <div className="flex justify-end pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handleSaveTaxiLogos}
                  disabled={savingLogoSettings}
                  className="px-6 py-2.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2 shadow-sm"
                >
                  {savingLogoSettings ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Saving Branding...
                    </>
                  ) : (
                    <>
                      <Save size={13} />
                      Save Branding Settings
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({ initial = false }) {
  const [enabled, setEnabled] = useState(initial);

  return (
    <button
      type="button"
      onClick={() => setEnabled((prev) => !prev)}
      className={`inline-flex items-center w-10 h-5 rounded-full border transition-all ${enabled ? "bg-blue-600 border-blue-600 justify-end" : "bg-slate-200 border-slate-300 justify-start"
        }`}
    >
      <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
    </button>
  );
}

