/**
 * Generate OTP and Token utilities
 */
const crypto = require('crypto');

/**
 * Generate a random OTP of specified length
 * @param {number} length - Length of OTP (default: 6)
 * @returns {string} - Generated OTP
 */
const generateOTP = (length = 6, phone = null) => {
  const cleanPhone = (phone || '').toString().replace(/\D/g, '').slice(-10);
  const testPhone = (process.env.TEST_OTP_PHONE || '6266925739').replace(/\D/g, '').slice(-10);
  // Static OTP: fail-closed, must be explicitly enabled AND never in production
  if (process.env.ALLOW_TEST_OTP === 'true' && process.env.NODE_ENV !== 'production' &&
      (cleanPhone === testPhone || process.env.USE_DEFAULT_OTP === 'true')) {
    return '123456';
  }

  let OTP = '';
  const len = typeof length === 'number' ? length : 6;
  for (let i = 0; i < len; i++) {
    OTP += crypto.randomInt(0, 10).toString();
  }
  return OTP;
};

/**
 * Generate a random token of specified length
 * @param {number} length - Length of token (default: 32)
 * @returns {string} - Generated token
 */
const generateToken = (length = 32) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    token += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return token;
};

module.exports = {
  generateOTP,
  generateToken
};

