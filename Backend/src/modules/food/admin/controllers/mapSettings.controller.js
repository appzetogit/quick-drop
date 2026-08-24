import { getMapApiSettings, saveGoogleMapsApiKey } from '../../../../core/settings/mapSettings.service.js';

/**
 * Google Maps key management for the Food admin panel.
 *
 * Reads and writes the same `map_apis` settings block as the taxi integration
 * screen, and is served under /food/admin so it does not depend on the taxi
 * module being enabled. The saved key is handed to every frontend through
 * /api/v1/env/public.
 */
export const getMapSettingsController = async (_req, res, next) => {
    try {
        const settings = await getMapApiSettings();
        res.status(200).json({
            success: true,
            message: 'Map settings fetched successfully',
            data: { googleMapsApiKey: settings.google_map_key_for_web_apps || '' }
        });
    } catch (error) {
        next(error);
    }
};

export const updateMapSettingsController = async (req, res, next) => {
    try {
        const raw = req.body?.googleMapsApiKey;
        if (raw !== undefined && raw !== null && typeof raw !== 'string') {
            return res.status(400).json({ success: false, message: 'googleMapsApiKey must be a string' });
        }
        if (String(raw || '').length > 200) {
            return res.status(400).json({ success: false, message: 'googleMapsApiKey is too long' });
        }
        const settings = await saveGoogleMapsApiKey(raw || '');
        res.status(200).json({
            success: true,
            message: 'Map settings saved successfully',
            data: { googleMapsApiKey: settings.google_map_key_for_web_apps || '' }
        });
    } catch (error) {
        next(error);
    }
};
