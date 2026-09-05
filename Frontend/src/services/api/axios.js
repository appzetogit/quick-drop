/**
 * Central API client for backend (auth and future APIs).
 * - baseURL from VITE_API_BASE_URL (e.g. https://k9rides.onrender.com/api/v1)
 * - When baseURL ends with /api/v1, request paths must NOT include /v1 (use /food/..., /auth/...)
 * - Attaches Bearer token (user or admin based on request URL)
 * - On 401: attempts refresh, retries once; on refresh failure logs out
 */

import axios from "axios";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const resolveApiBaseUrl = () => {
  const envValue =
    typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL
      ? String(import.meta.env.VITE_API_BASE_URL).trim().replace(/\/$/, "")
      : "";

  if (!envValue) return "";

  // Safety fallback:
  // If a localhost API URL is baked into a deployed build, the browser on production
  // machines will try connecting to THEIR localhost and requests will hang/timeout.
  // In that case, force same-origin API path so production routing/proxy can handle it.
  try {
    const parsed = new URL(envValue);
    if (typeof window !== "undefined") {
      const isEnvLocal = LOCAL_HOSTS.has(parsed.hostname);
      const isBrowserLocal = LOCAL_HOSTS.has(window.location.hostname);
      if (isEnvLocal && !isBrowserLocal) {
        return "";
      }
    }
  } catch (_) {
    // Keep original value when parsing fails (relative/custom values).
  }

  return envValue;
};

// Prefer explicit env. If not set, use same-origin (works with reverse proxy).
const baseURL = resolveApiBaseUrl();

const apiClient = axios.create({
  baseURL: baseURL || undefined,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

function getModuleFromUrl(url = "") {
  const u = typeof url === "string" ? url : (url?.url || "");
  if (!u) return "user";
  
  const normalized = u.toLowerCase();
  
  // Admin detection
  if (
    normalized.includes("/admin/") ||
    normalized.includes("/food/admin/") ||
    normalized.includes("/food/auth/admin") ||
    normalized.includes("/auth/admin") ||
    normalized.includes("admin/login")
  ) return "admin";

  // Landing management (hero/top banners) is an admin surface even though its URLs
  // carry no /admin/ segment -- the backend guards every non-public path on it with
  // requireRoles('ADMIN'). Classifying it as "user" meant no admin token was attached
  // and every banner call 401'd on pages that rely on the interceptor. Public reads
  // stay unclassified so the user app's banner fetches keep working tokenless.
  if (
    (normalized.includes("/hero-banners") || normalized.includes("/top-banners")) &&
    !/\/public(\?|$)/.test(normalized)
  ) return "admin";
  
  // Delivery detection - Catch all delivery-specific functional and auth routes
  if (
    normalized.includes("/food/delivery") || 
    normalized.includes("/auth/delivery") || 
    normalized.includes("/delivery/")
  ) return "delivery";
  
  // Restaurant detection - Catch all restaurant-specific functional and auth routes
  if (
    normalized.includes("/food/restaurant/") || 
    normalized.includes("/auth/restaurant") || 
    normalized.includes("/restaurant/")
  ) {
    // Exception: /food/restaurants (plural) is usually a public user app route
    if (normalized.includes("/food/restaurants") && !normalized.includes("/food/restaurant/")) {
       return "user";
    }
    return "restaurant";
  }
  
  return "user";
}

function getModuleFromConfig(config) {
  if (config?.contextModule) return config.contextModule;
  return getModuleFromUrl(config?.url);
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function isTokenForModule(token, module) {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const role = String(payload.role || "").toLowerCase();

  if (module === "user") return role === "user" && Boolean(payload.userId);
  // super_admin included: promoting an account changed its token role and made this
  // exact match silently DROP the stored admin token from admin requests.
  if (module === "admin") return ["admin", "super_admin"].includes(role) && Boolean(payload.userId);
  if (module === "restaurant") return role === "restaurant" && Boolean(payload.userId);
  if (module === "delivery") return ["delivery_partner", "delivery"].includes(role) && Boolean(payload.userId);

  return true;
}

/**
 * The shared upload endpoint is used by every panel, so no single module owns
 * it. Classifying it (it has no /admin/ or /restaurant/ segment) landed it on
 * "user", which meant an admin session attached no token at all -- fine while
 * the endpoint was open to anyone, and immediately broken once it was not.
 *
 * Whichever panel the operator is signed into is the right token, so try them
 * in turn and send the first real one.
 */
const UPLOAD_TOKEN_ORDER = ["admin", "restaurant", "delivery", "user"];

function getUploadToken() {
  for (const module of UPLOAD_TOKEN_ORDER) {
    try {
      const token = localStorage.getItem(`${module}_accessToken`);
      if (token && isTokenForModule(token, module)) return token;
    } catch {
      // localStorage can throw in a private window; just try the next one.
    }
  }
  try {
    return localStorage.getItem("accessToken") || null;
  } catch {
    return null;
  }
}

function getAccessToken(config) {
  const module = getModuleFromConfig(config);
  if (!config?.contextModule && /\/uploads\//.test(String(config?.url || ""))) {
    const uploadToken = getUploadToken();
    if (uploadToken) return uploadToken;
  }
  const key = `${module}_accessToken`;
  try {
    // 1. Try module-specific token first
    const moduleToken = localStorage.getItem(key);
    if (moduleToken && isTokenForModule(moduleToken, module)) return moduleToken;
    
    // 2. Fallback to generic token only if it matches this Food module shape.
    if (module !== "admin") {
      const genericToken = localStorage.getItem("accessToken");
      return genericToken && isTokenForModule(genericToken, module) ? genericToken : null;
    }
    return null;
  } catch {
    return null;
  }
}

function getRefreshToken(module) {
  try {
    // 1. Try module-specific refresh token
    const moduleRefreshToken = localStorage.getItem(`${module}_refreshToken`);
    if (moduleRefreshToken) return moduleRefreshToken;
    
    // 2. Fallback to generic refresh token only for non-admin modules
    if (module !== "admin") {
      return localStorage.getItem("refreshToken") || null;
    }
    return null;
  } catch {
    return null;
  }
}

function clearModuleAuth(module) {
  try {
    localStorage.removeItem(`${module}_accessToken`);
    localStorage.removeItem(`${module}_refreshToken`);
    localStorage.removeItem(`${module}_authenticated`);
    localStorage.removeItem(`${module}_user`);
    if (module === "user") {
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      localStorage.removeItem("authenticated");
      localStorage.removeItem("user");
    }
  } catch (_) {}
}

let isRefreshing = false;
let refreshSubscribers = [];

function subscribeToRefresh(cb) {
  refreshSubscribers.push(cb);
}

function onRefreshed(newToken, module) {
  refreshSubscribers.forEach((cb) => cb(newToken, module));
  refreshSubscribers = [];
}

function onRefreshFailed(module) {
  clearModuleAuth(module);
  // Fail any queued requests that were waiting for this refresh
  refreshSubscribers.forEach((cb) => cb(null, module));
  refreshSubscribers = [];
  
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("authRefreshFailed", { detail: { module } }));
  }
}

/**
 * Point the admin screens at quick-commerce when they are being viewed there.
 *
 * /admin/food and /admin/quick-commerce render the SAME components (see AdminRouter),
 * because quick-commerce is a fork of this repo's food module and its admin API is the
 * identical route table under /v1/qc/admin. Rather than thread a prefix through the
 * ~150 call sites in services/api, the swap happens here, once.
 *
 * Derived from the current URL rather than held in a module variable on purpose: a
 * mutable global would have to be kept in step with client-side navigation, and would
 * be wrong for any request already in flight when the admin switches vertical.
 *
 * The WHOLE /food namespace moves, not just /food/admin. quick-commerce mounts the
 * same routers master mounts under /v1/food -- admin, restaurant, delivery, orders,
 * user, notifications, search, dining and the landing router that owns hero-banners --
 * so /food/<x> and /qc/<x> are the same endpoint in two verticals.
 *
 * Rewriting only /food/admin (as this first did) left every other screen writing into
 * food while the operator was looking at quick-commerce. Banner uploads were the
 * visible case -- they post to /food/showcase-items/multiple, which is not under
 * /food/admin -- but restaurants, delivery, zones and orders had the same fault.
 *
 * EXCEPT auth: /food/auth/* stays pointed at the platform so one login covers every
 * vertical. That exclusion is the reason this is a negative-lookahead rather than a
 * blanket replace.
 */
const SHARED_FOOD_PREFIXES = ["auth"];

const rewriteAdminVertical = (url) => {
  if (typeof url !== "string" || !url) return url;
  if (typeof window === "undefined") return url;
  if (!window.location.pathname.startsWith("/admin/quick-commerce")) return url;
  const shared = SHARED_FOOD_PREFIXES.join("|");
  return url.replace(new RegExp(`(^|/)food/(?!(?:${shared})(?:/|$))`), "$1qc/");
};

apiClient.interceptors.request.use(
  (config) => {
    config.url = rewriteAdminVertical(config.url);
    config.contextModule = getModuleFromConfig(config);

    // If sending FormData, let the browser set proper multipart boundary.
    if (config.data instanceof FormData) {
      if (config.headers && config.headers["Content-Type"]) {
        delete config.headers["Content-Type"];
      }
    }

    const token = getAccessToken(config);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (err) => Promise.reject(err)
);

apiClient.interceptors.response.use(
  (response) => response,
  async (err) => {
    const original = err?.config;
    if (err?.response?.status === 429) {
      return Promise.reject(err);
    }
    if (err?.response?.status !== 401 || !original || original._retry) {
      return Promise.reject(err);
    }
    const module = original.contextModule || getModuleFromUrl(original.url);
    const refreshToken = getRefreshToken(module);
    if (!refreshToken) {
      clearModuleAuth(module);
      return Promise.reject(err);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        subscribeToRefresh((newToken) => {
          if (newToken) {
            original.headers.Authorization = `Bearer ${newToken}`;
            resolve(apiClient(original));
          } else {
            reject(err);
          }
        });
      });
    }

    original._retry = true;
    isRefreshing = true;

    try {
      // Use relative URL so this works both with an explicit baseURL and with a dev proxy.
      // Use plain axios to avoid interceptor recursion.
      const refreshUrl = baseURL ? `${baseURL}/food/auth/refresh-token` : "/api/v1/food/auth/refresh-token";
      const { data } = await axios.post(refreshUrl, { refreshToken }, { timeout: 10000 });
      const newAccessToken = data?.data?.accessToken || data?.accessToken;
      if (newAccessToken) {
        try {
          localStorage.setItem(`${module}_accessToken`, newAccessToken);
          // Dispatch a custom event specifically for the module that refreshed
          window.dispatchEvent(new CustomEvent("authRefreshed", { 
            detail: { module, token: newAccessToken } 
          }));
        } catch (_) {}
        onRefreshed(newAccessToken, module);
        original.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(original);
      }
    } catch (_) {
      onRefreshFailed(module);
      return Promise.reject(err);
    } finally {
      isRefreshing = false;
    }

    onRefreshFailed(module);
    return Promise.reject(err);
  }
);

export default apiClient;
