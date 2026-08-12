import axios from 'axios';
import { API_BASE_URL } from './runtimeConfig';
import { syncAdminSessionBridge } from '../../modules/admin/services/adminSession';

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

const DEDUPED_GET_TTL_MS = 2500;
const dedupedGetRequests = new Map();
const recentDedupedGetResponses = new Map();

const isDedupedGet = (url = '') => {
  const requestPath = String(url || '').split('?')[0];

  return /^\/users\/me$/.test(requestPath) ||
    /^\/drivers\/me$/.test(requestPath) ||
    /^\/rides\/active\/me$/.test(requestPath) ||
    /^\/deliveries\/active\/me$/.test(requestPath) ||
    /^\/admin\/general-settings\/[^/]+$/.test(requestPath) ||
    /^\/common\/payment-gateway$/.test(requestPath) ||
    /^\/admin\/(countries|service-locations|notification-channels)$/.test(requestPath) ||
    /^\/(countries|common\/ride_modules)$/.test(requestPath);
};

const getDedupedRequestKey = (url = '', config = {}) => {
  const params = config?.params ? JSON.stringify(config.params) : '';
  return `${String(url || '')}|${params}`;
};

const decodeBase64Url = (value) => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  return normalized + '='.repeat(padding);
};

const getTokenPayload = (token) => {
  if (!token || typeof token !== 'string') {
    return null;
  }

  try {
    const payload = token.split('.')[1];

    if (!payload) {
      return null;
    }

    return JSON.parse(atob(decodeBase64Url(payload)));
  } catch {
    return null;
  }
};

const normalizeAuthRole = (role) => {
  const value = String(role || '').toLowerCase();
  if (value === 'super-admin') {
    return 'admin';
  }
  return value;
};

const getSessionItem = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const getStoredTokenByRole = (role) => {
  const normalizedRole = normalizeAuthRole(role);
  const entries = (
    normalizedRole === 'driver' || normalizedRole === 'owner'
      ? [
          getSessionItem('driverToken'),
          getSessionItem('token'),
          localStorage.getItem('driverToken'),
          localStorage.getItem('token'),
        ]
      : [
          normalizedRole === 'admin' ? localStorage.getItem('admin_accessToken') : null,
          localStorage.getItem(`${role}Token`),
          localStorage.getItem('token'),
        ]
  ).filter(Boolean);

  return entries.find((token) => normalizeAuthRole(getTokenPayload(token)?.role) === normalizedRole) || null;
};

const getRoleFromPathname = () => {
  if (typeof window === 'undefined') {
    return '';
  }

  const pathname = String(window.location.pathname || '').toLowerCase();

  if (pathname.includes('/admin')) {
    return 'admin';
  }

  // Owners currently authenticate with driver tokens (fleet-owner flow).
  if (pathname.includes('/taxi/owner')) {
    return 'driver';
  }

  if (pathname.includes('/taxi/driver') || pathname.includes('/driver')) {
    return 'driver';
  }

  if (pathname.includes('/taxi/user') || pathname.includes('/user')) {
    return 'user';
  }

  return '';
};

const clearStaleAuthState = (role = '', staleToken = '') => {
  const normalizedRole = normalizeAuthRole(role);
  const currentGenericToken = localStorage.getItem('token');
  const currentSessionGenericToken = getSessionItem('token');
  const shouldClearGenericToken =
    !staleToken ||
    currentGenericToken === staleToken ||
    currentSessionGenericToken === staleToken ||
    normalizeAuthRole(getTokenPayload(currentGenericToken)?.role) === normalizedRole;

  if (shouldClearGenericToken) {
    localStorage.removeItem('token');
    try {
      sessionStorage.removeItem('token');
    } catch {}
  }

  if (!normalizedRole || normalizedRole === 'user') {
    if (!staleToken || localStorage.getItem('userToken') === staleToken) {
      localStorage.removeItem('userToken');
    }
    localStorage.removeItem('userInfo');
  }

  if (!normalizedRole || normalizedRole === 'driver' || normalizedRole === 'owner') {
    if (!staleToken || localStorage.getItem('driverToken') === staleToken) {
      localStorage.removeItem('driverToken');
    }
    try {
      if (!staleToken || getSessionItem('driverToken') === staleToken) {
        sessionStorage.removeItem('driverToken');
      }
      sessionStorage.removeItem('driverInfo');
      sessionStorage.removeItem('chatRole');
    } catch {}
    localStorage.removeItem('driverInfo');
  }

  if (!normalizedRole || normalizedRole === 'admin') {
    if (!staleToken || localStorage.getItem('admin_accessToken') === staleToken) {
      localStorage.removeItem('admin_accessToken');
    }
    localStorage.removeItem('admin_refreshToken');
    localStorage.removeItem('admin_user');
    if (!staleToken || localStorage.getItem('adminToken') === staleToken) {
      localStorage.removeItem('adminToken');
    }
    localStorage.removeItem('adminInfo');
  }

  localStorage.removeItem('chatRole');
};

const isAuthTokenFailure = (message = '') => {
  const normalized = String(message || '').trim().toLowerCase();
  if (!normalized) return false;

  return normalized.includes('authorization token has expired') ||
    normalized.includes('authorization token is invalid') ||
    normalized.includes('authorization token is required') ||
    normalized.includes('jwt expired');
};

// Request Interceptor: Attach Auth Token automatically
api.interceptors.request.use(
  (config) => {
    syncAdminSessionBridge();
    const requestPath = String(config.url || '').split('?')[0];
    const existingAuthorization =
      config.headers?.Authorization ||
      config.headers?.authorization ||
      (config.headers && typeof config.headers.get === 'function' ? config.headers.get('Authorization') : null);

    if (existingAuthorization) {
      return config;
    }

    const chatRole = localStorage.getItem('chatRole');
    const normalizedChatRole = String(chatRole || '').toLowerCase();
    const userToken = getStoredTokenByRole('user');
    const driverToken = getStoredTokenByRole('driver');
    const ownerToken = getStoredTokenByRole('owner');
    const adminToken = getStoredTokenByRole('admin') || localStorage.getItem('adminToken');

    const isPublicUserRoute =
      /^\/users\/(app-modules|goods-types|vehicle-types|register|signup|login|profile-image|auth\/send-otp|auth\/verify-otp|otp-login)(\/|$)/.test(requestPath);
    const isPublicDriverRoute =
      /^\/drivers\/(register|login|auth\/send-otp|auth\/verify-otp|onboarding\/send-otp|onboarding\/verify-otp|onboarding\/personal|onboarding\/referral|onboarding\/vehicle|onboarding\/documents|onboarding\/complete|onboarding\/session\/|service-locations)(\/|$)/.test(requestPath);
    const isAdminRoute =
      /^\/admin(\/|$)/.test(requestPath) ||
      /^\/(countries|common\/ride_modules|types\/|on-boarding(?:-|\/|$)|roles\/|permissions\/)/.test(requestPath);
    const isDriverRoute = /^\/drivers?(\/|$)/.test(requestPath);
    const isUserRoute = /^\/(users|rides|deliveries|promos)(\/|$)/.test(requestPath);
    const isSupportRoute = /^\/support(\/|$)/.test(requestPath);
    const isChatRoute = /^\/chats?(\/|$)/.test(requestPath);
    const pathRole = getRoleFromPathname();

    let token = null;

    if (isPublicUserRoute || isPublicDriverRoute) {
      token = null;
    } else if (isChatRoute) {
      if (normalizedChatRole === 'admin') {
        token = adminToken;
      } else if (normalizedChatRole === 'driver') {
        token = driverToken || ownerToken;
      } else if (normalizedChatRole === 'owner') {
        token = ownerToken || driverToken;
      } else if (normalizedChatRole === 'user') {
        token = userToken;
      }
    } else if (isAdminRoute) {
      token = adminToken;
    } else if (isSupportRoute) {
      if (pathRole === 'admin') {
        token = adminToken;
      } else if (pathRole === 'driver') {
        token = driverToken || ownerToken;
      } else {
        token = userToken;
      }
    } else if (isUserRoute) {
      token = userToken;
    } else if (isDriverRoute) {
      token = driverToken || ownerToken;
    } else {
      token = userToken || driverToken || ownerToken || adminToken;
    }

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response Interceptor: Simplify responses and handle global errors
api.interceptors.response.use(
  (response) => {
    // Pro-Level: Many APIs return data in data.data or data.result, you can flatten it here
    return response.data;
  },
  (error) => {
    if (error.response) {
      // Global error handling: e.g. deleted or inactive account logout
      if (error.response.status === 401 || error.response.status === 403) {
        const serverMessage = String(error.response.data?.message || '');
        const authHeader = error.config?.headers?.Authorization || error.config?.headers?.authorization || '';
        const token = String(authHeader).startsWith('Bearer ') ? String(authHeader).slice(7) : '';
        const tokenRole = normalizeAuthRole(getTokenPayload(token)?.role || '');

        const shouldClearAuth =
          (error.response.status === 401 && isAuthTokenFailure(serverMessage)) ||
          serverMessage === 'Authenticated account no longer exists' ||
          (tokenRole === 'user' && serverMessage === 'User account is not active');

        if (shouldClearAuth) {
          clearStaleAuthState(tokenRole, token);
          window.dispatchEvent(new CustomEvent('app:auth-stale', {
            detail: { role: tokenRole || null, message: serverMessage, token },
          }));
        }
      }
      return Promise.reject({ ...error.response.data, status: error.response.status });
    }

    return Promise.reject({ message: 'Network error or server down.' });
  }
);

const rawGet = api.get.bind(api);

api.get = (url, config = {}) => {
  if (!isDedupedGet(url)) {
    return rawGet(url, config);
  }

  const key = getDedupedRequestKey(url, config);
  const now = Date.now();
  const cached = recentDedupedGetResponses.get(key);

  if (cached && now - cached.timestamp < DEDUPED_GET_TTL_MS) {
    return Promise.resolve(cached.data);
  }

  const pending = dedupedGetRequests.get(key);

  if (pending) {
    return pending;
  }

  const request = rawGet(url, config)
    .then((data) => {
      recentDedupedGetResponses.set(key, {
        data,
        timestamp: Date.now(),
      });
      return data;
    })
    .finally(() => {
      dedupedGetRequests.delete(key);
    });

  dedupedGetRequests.set(key, request);
  return request;
};

export default api;
