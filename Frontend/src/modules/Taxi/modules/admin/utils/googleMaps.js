import { useJsApiLoader } from '@react-google-maps/api';
import { getGoogleMapsApiKeySync } from '@food/utils/googleMapsApiKey';

/**
 * Google Maps for the taxi admin panel.
 *
 * The key comes from the same place the food admin panel gets it: the runtime
 * config at /api/v1/env/public, which serves what an admin saved under
 * Integration settings -> Map. Both panels write the one `map_apis` block on the
 * server, so there is a single key and a single reader.
 *
 * This module used to snapshot `env('VITE_GOOGLE_MAPS_API_KEY')` into a const at
 * import time. Runtime config is fetched over the network, so that snapshot was a
 * race: lose it and the panel froze the empty build-time value forever, and
 * useJsApiLoader -- which calls load() once from an effect with no dependencies --
 * never retried. index.jsx now resolves the runtime config before the first
 * render, so reading it here is safe; going through the shared helper keeps the
 * sanitizing identical rather than reimplemented.
 */

export const GOOGLE_MAPS_API_KEY = getGoogleMapsApiKeySync();

export const HAS_VALID_GOOGLE_MAPS_KEY =
  typeof GOOGLE_MAPS_API_KEY === 'string' &&
  GOOGLE_MAPS_API_KEY.trim() !== '' &&
  GOOGLE_MAPS_API_KEY !== 'your-google-maps-browser-key';

export const INDIA_CENTER = { lat: 22.7196, lng: 75.8577 };
export const DELHI_CENTER = { lat: 28.6139, lng: 77.209 };
export const GOOGLE_MAPS_LOADER_ID = 'K9 Rides-google-maps';
export const GOOGLE_MAPS_LIBRARIES = ['drawing', 'places', 'visualization'];

export const getLatLng = (source, fallback = INDIA_CENTER) => {
  const lat = Number(source?.lat ?? source?.latitude);
  const lng = Number(source?.lng ?? source?.longitude ?? source?.lon);

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng };
  }

  return fallback;
};

export const useAppGoogleMapsLoader = () =>
  useJsApiLoader({
    id: GOOGLE_MAPS_LOADER_ID,
    googleMapsApiKey: HAS_VALID_GOOGLE_MAPS_KEY ? GOOGLE_MAPS_API_KEY : '',
    libraries: GOOGLE_MAPS_LIBRARIES,
    version: '3.55'
  });
