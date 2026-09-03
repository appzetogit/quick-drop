import { ValidationError } from '../../../core/auth/errors.js';

export const STORE_TYPES = { GENERAL: 'general', PHARMACY: 'pharmacy' };

/**
 * A medical store is a quick-commerce seller with `storeType: 'pharmacy'` --
 * everything else about onboarding is shared with a general seller, except the
 * drug licence, which the business cannot legally operate without.
 */
export function assertMedicalOnboarding(payload) {
  if (payload.storeType !== STORE_TYPES.PHARMACY) return;

  const missing = [];
  if (!String(payload.drugLicenseNumber || '').trim()) missing.push('drug licence number');
  if (!payload.drugLicenseExpiry) missing.push('drug licence expiry');
  if (!payload.drugLicenseImage) missing.push('drug licence image');
  if (missing.length) {
    throw new ValidationError(`Medical stores must provide ${missing.join(', ')}`);
  }

  const expiry = new Date(payload.drugLicenseExpiry);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw new ValidationError('Drug licence must not be expired');
  }
}
