import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import App from './app/App.jsx'
import { isModuleAuthenticated } from './modules/Food/utils/auth.js'
import { applySavedTheme } from './shared/utils/theme.js'
import './shared/styles/global.css'

const NATIVE_LAST_ROUTE_KEY = 'native_last_route'

// ─── Quick-spicy Food Module Initialization ───────────────────────────────────

// Runtime config (Firebase, maps key) from the backend's admin-managed settings.
//
// Awaited before the first render, where it used to be fire-and-forget. Consumers
// that read a value at module scope captured whatever happened to be present when
// their module was first imported, and the Google Maps loader compounds it: it
// calls load() once from an effect with an empty dependency list, so a key that
// arrives later is never picked up. Losing that race did not delay the map, it
// broke it for the rest of the page's life.
//
// Capped, so a slow or unreachable settings endpoint cannot hold the app back --
// on timeout the build-time values stand, exactly as before.
const RUNTIME_ENV_MAX_WAIT_MS = 1500

const loadRuntimeConfig = async () => {
  try {
    const { loadRuntimeEnv } = await import('./config/runtimeEnv.js')
    await Promise.race([
      loadRuntimeEnv(),
      new Promise((resolve) => setTimeout(resolve, RUNTIME_ENV_MAX_WAIT_MS))
    ])
  } catch {
    /* build-time env stands */
  }
}

// Load food module business settings (favicon, title) — non-critical
import('./modules/Food/utils/businessSettings.js')
  .then(({ loadBusinessSettings }) => loadBusinessSettings())
  .catch(() => { /* Silently fail — settings load when admin authenticates */ })

applySavedTheme()

function isNativeLikeShell() {
  if (typeof window === 'undefined') return false

  const protocol = String(window.location?.protocol || '').toLowerCase()
  const userAgent = String(window.navigator?.userAgent || '').toLowerCase()

  return (
    Boolean(window.flutter_inappwebview) ||
    Boolean(window.ReactNativeWebView) ||
    protocol === 'file:' ||
    userAgent.includes(' wv') ||
    userAgent.includes('; wv')
  )
}

function resolveNativeInitialRoute() {
  if (typeof window === 'undefined') return '/food/user'

  const rawPathname = String(window.location?.pathname || '')
  const pathname = rawPathname.replace(/\/index\.html$/i, '') || '/'
  const storedRoute = String(localStorage.getItem(NATIVE_LAST_ROUTE_KEY) || '').trim()

  if (pathname.startsWith('/taxi/')) return pathname
  if (pathname.startsWith('/food/')) return pathname
  if (pathname.startsWith('/restaurant')) return `/food${pathname}`
  if (pathname.startsWith('/delivery')) return `/food${pathname}`
  if (pathname.startsWith('/user')) return `/food${pathname}`
  if (pathname.startsWith('/admin')) return pathname
  if (storedRoute.startsWith('/taxi/')) {
    return storedRoute
  }
  if (storedRoute.startsWith('/food/') || storedRoute.startsWith('/admin')) {
    return storedRoute
  }

  if (isModuleAuthenticated('restaurant')) return '/food/restaurant'
  if (isModuleAuthenticated('delivery')) return '/food/delivery'
  if (isModuleAuthenticated('admin')) return '/admin'
  if (isModuleAuthenticated('user')) return '/food/user'

  return '/food/user'
}

function bootstrapNativeHashRoute() {
  if (!isNativeLikeShell() || typeof window === 'undefined') return

  const currentHash = String(window.location?.hash || '')
  const hashPath = currentHash.startsWith('#') ? currentHash.slice(1).split('?')[0] : ''
  const rawPathname = String(window.location?.pathname || '')
  const pathname = rawPathname.replace(/\/index\.html$/i, '') || '/'
  const targetPath = resolveNativeInitialRoute()
  const search = String(window.location?.search || '')

  if (currentHash.startsWith('#/')) {
    const nativePathPrefix = targetPath.startsWith('/taxi/')
      ? '/taxi/'
      : targetPath.startsWith('/food/')
        ? '/food/'
        : targetPath.startsWith('/admin')
          ? '/admin'
          : ''

    const hashMatchesPrefix = nativePathPrefix ? hashPath.startsWith(nativePathPrefix) : false;
    const pathSuggestsTaxi = pathname.startsWith('/taxi/');

    // Normalize stale hash routes in native shells (e.g. /taxi/... with #/food/...)
    if ((pathSuggestsTaxi && !hashPath.startsWith('/taxi/')) || !hashMatchesPrefix) {
      window.history.replaceState(null, '', `#${targetPath}${search}`)
    }
    return
  }

  window.history.replaceState(null, '', `#${targetPath}${search}`)
}

bootstrapNativeHashRoute()

// ─── Suppress known non-critical errors ──────────────────────────────────────

const originalError = console.error
console.error = (...args) => {
  const errorStr = args.join(' ')

  if (typeof args[0] === 'string' && (
    args[0].includes('chrome-extension://') ||
    args[0].includes('_$initialUrl') ||
    args[0].includes('_$onReInit') ||
    args[0].includes('_$bindListeners')
  )) return

  if (
    errorStr.includes('Timeout expired') ||
    errorStr.includes('GeolocationPositionError') ||
    errorStr.includes('Geolocation error') ||
    errorStr.includes('User denied Geolocation') ||
    errorStr.includes('permission denied')
  ) return

  const hasNetworkError = args.some(arg =>
    arg && typeof arg === 'object' &&
    (arg.name === 'AxiosError') &&
    (arg.code === 'ERR_NETWORK' || arg.message === 'Network Error')
  )
  if (hasNetworkError) return

  if (
    errorStr.includes('🌐 Network Error') ||
    errorStr.includes('Network Error - Backend server may not be running') ||
    (errorStr.includes('ERR_NETWORK') && errorStr.includes('AxiosError'))
  ) return

  if (
    errorStr.includes('Restaurant Socket connection error') ||
    errorStr.includes('xhr poll error') ||
    (errorStr.includes('WebSocket connection to') && errorStr.includes('socket.io') && errorStr.includes('failed'))
  ) return

  originalError.apply(console, args)
}

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason || event
  const errorMsg = error?.message || String(error) || ''
  const errorName = error?.name || ''
  if (
    errorMsg.includes('Timeout expired') ||
    errorMsg.includes('User denied Geolocation') ||
    errorMsg.includes('permission denied') ||
    errorName === 'GeolocationPositionError'
  ) {
    event.preventDefault()
    return
  }
})

// ─────────────────────────────────────────────────────────────────────────────

import { AppProviders } from './app/providers.jsx'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element not found')

loadRuntimeConfig().then(() => {
  createRoot(rootElement).render(
    <AppProviders>
      <App />
    </AppProviders>
  )
})
