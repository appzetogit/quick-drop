const crypto = require('crypto');
const { getRedis, isRedisConnected } = require('../services/redisService');
const Token = require('../models/Token'); // Fallback model
const { TOKEN_TYPES } = require('./constants'); // Need to ensure constants file is reachable or define types here
// Note: imports might need adjustment based on directory structure. 
// constants is in ../utils/constants.js usually, but this file is in utils/ so ./constants

// Constants if not imported
const OTP_EXPIRY = parseInt(process.env.OTP_EXPIRY_SECONDS) || 300;
// Default aligned with master's config.otpMaxAttempts (src/config/env.js), which
// defaults to 5. Both read the same OTP_MAX_ATTEMPTS env var, so in a configured
// environment they already agree -- this only matters when the var is unset, where
// the old 3-vs-5 split gave the platform two different lockout policies.
const MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS) || 5;
const RATE_LIMIT_COUNT = parseInt(process.env.OTP_RATE_LIMIT) || 3;
const RATE_LIMIT_WINDOW = parseInt(process.env.OTP_RATE_WINDOW) || 600;

// Test-OTP escape hatch. Fail-closed: must be explicitly enabled AND never in production.
const TEST_PHONE = (process.env.TEST_OTP_PHONE || '6266925739').replace(/\D/g, '').slice(-10);
const testOtpAllowed = () =>
  process.env.ALLOW_TEST_OTP === 'true' && process.env.NODE_ENV !== 'production';

/**
 * Generate 6-digit OTP
 */
const generateOTP = (phone = null) => {
  const cleanPhone = (phone || '').toString().replace(/\D/g, '').slice(-10);
  if (testOtpAllowed() && (cleanPhone === TEST_PHONE || process.env.USE_DEFAULT_OTP === 'true')) {
    return '123456';
  }
  return crypto.randomInt(100000, 1000000).toString();
};

/**
 * Hash OTP using SHA-256
 */
const hashOTP = (otp) => {
  return crypto.createHash('sha256').update(otp).digest('hex');
};

/**
 * Check rate limit for phone number
 * Returns true if allowed, false if limit exceeded
 * NOTE: Rate limiting primarily uses Redis. If Redis is down, we ALLOW the request 
 * to prevent blocking users during outages (fail-open), or we could implement basic memory/mongo limit.
 * For now: Fail-open for simple rate limiting if Redis is down.
 */
const checkRateLimit = async (phone) => {
  const redis = getRedis();
  if (!isRedisConnected() || !redis) {
    console.warn('[OTP] Redis down, skipping rate limit check (fail-open)');
    return true;
  }

  const key = `rate:otp:${phone}`;
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }
    return current <= RATE_LIMIT_COUNT;
  } catch (err) {
    console.error('[OTP] Rate limit error:', err);
    return true; // Fail open
  }
};

/**
 * Store OTP (Redis Primary -> MongoDB Fallback)
 */
const storeOTP = async (phone, otpHash) => {
  const redis = getRedis();

  // 1. Try Redis
  if (isRedisConnected() && redis) {
    try {
      const key = `otp:${phone}`;
      const data = JSON.stringify({ hash: otpHash, attempts: 0 });
      await redis.set(key, data, 'EX', OTP_EXPIRY);
      console.log(`[OTP] Stored in Redis for ${phone}`);
      return true;
    } catch (err) {
      console.error('[OTP] Redis store failed, falling back to MongoDB:', err);
    }
  }

  // 2. Fallback to MongoDB
  try {
    // Delete existing tokens for this phone & type
    await Token.deleteMany({ phone, type: 'PHONE_VERIFICATION' });

    // Create new token
    await Token.create({
      phone,
      type: 'PHONE_VERIFICATION',
      token: otpHash, // Storing hash in token field for compatibility
      otp: otpHash,   // Also storing in otp field (hashed)
      expiresAt: new Date(Date.now() + OTP_EXPIRY * 1000),
      attempts: 0
    });
    console.log(`[OTP] Stored in MongoDB (Fallback) for ${phone}`);
    return true;
  } catch (err) {
    console.error('[OTP] MongoDB fallback failed:', err);
    throw new Error('Failed to generate OTP');
  }
};

/**
 * Verify OTP (Redis Primary -> MongoDB Fallback)
 * Returns: { success: true/false, message: string }
 */
const verifyOTP = async (phone, plainOtp) => {
  console.log(`[OTP] Verifying OTP for phone: ${phone}`);

  const cleanPhone = (phone || '').toString().replace(/\D/g, '').slice(-10);

  // Static OTP: test number only, gated behind ALLOW_TEST_OTP and never in production
  if (testOtpAllowed() && cleanPhone === TEST_PHONE && plainOtp === '123456') {
    console.log(`[OTP] ✅ Static OTP used for ${phone}`);
    return { success: true };
  }

  const redis = getRedis();
  const inputHash = hashOTP(plainOtp);

  // 1. Try Redis
  if (isRedisConnected() && redis) {
    try {
      const key = `otp:${phone}`;
      const data = await redis.get(key);

      if (data) {
        console.log(`[OTP] Found in Redis for ${phone}`);
        const otpData = JSON.parse(data);

        // Check attempts
        if (otpData.attempts >= MAX_ATTEMPTS) {
          await redis.del(key);
          console.log(`[OTP] Max attempts exceeded for ${phone}`);
          return { success: false, message: 'Too many attempts. Please request new OTP.' };
        }

        // Verify Hash
        if (otpData.hash !== inputHash) {
          otpData.attempts += 1;
          // Update attempts, keep remaining TTL
          const ttl = await redis.ttl(key);
          if (ttl > 0) {
            await redis.set(key, JSON.stringify(otpData), 'EX', ttl);
          }
          console.log(`[OTP] Invalid OTP for ${phone}, attempts: ${otpData.attempts}`);
          return { success: false, message: 'Invalid OTP' };
        }

        // Success
        await redis.del(key);
        console.log(`[OTP] ✅ Verification successful for ${phone}`);
        return { success: true };
      } else {
        console.log(`[OTP] Not found in Redis for ${phone}, checking MongoDB...`);
      }
    } catch (err) {
      console.error('[OTP] Redis verify failed, trying MongoDB:', err);
    }
  }

  // 2. Check MongoDB (Fallback)
  try {
    const tokenDoc = await Token.findOne({
      phone,
      type: 'PHONE_VERIFICATION',
      isUsed: false
    });

    if (!tokenDoc) {
      console.log(`[OTP] ❌ Not found in MongoDB for ${phone}`);
      return { success: false, message: 'Invalid or expired OTP. Please request a new one.' };
    }

    console.log(`[OTP] Found in MongoDB for ${phone}`);

    // Check expiry
    if (tokenDoc.expiresAt < new Date()) {
      await Token.deleteOne({ _id: tokenDoc._id });
      console.log(`[OTP] Expired in MongoDB for ${phone}`);
      return { success: false, message: 'OTP expired. Please request a new one.' };
    }

    // Check attempts
    if (tokenDoc.attempts >= MAX_ATTEMPTS) {
      await Token.deleteOne({ _id: tokenDoc._id });
      console.log(`[OTP] Max attempts exceeded in MongoDB for ${phone}`);
      return { success: false, message: 'Too many attempts. Please request a new one.' };
    }

    // Verify Hash (Token stores hash in this new design)
    // Note: Old implementation stored plain OTP. 
    // This check supports both logic if needed, but we assume new OTPs are hashed.
    // If migration needed: check length of stored OTP. SHA256 hex is 64 chars.
    let isMatch = false;
    if (tokenDoc.otp.length === 64) {
      isMatch = tokenDoc.otp === inputHash;
    } else {
      // Old plain text fallback (for dev/legacy)
      isMatch = tokenDoc.otp === plainOtp;
    }

    if (!isMatch) {
      tokenDoc.attempts += 1;
      await tokenDoc.save();
      console.log(`[OTP] Invalid OTP in MongoDB for ${phone}, attempts: ${tokenDoc.attempts}`);
      return { success: false, message: 'Invalid OTP' };
    }

    // Success
    await Token.deleteOne({ _id: tokenDoc._id }); // Or mark used
    console.log(`[OTP] ✅ Verification successful (MongoDB) for ${phone}`);
    return { success: true };

  } catch (err) {
    console.error('[OTP] MongoDB verify error:', err);
    return { success: false, message: 'Verification failed. Please try again.' };
  }
};

module.exports = {
  generateOTP,
  hashOTP,
  checkRateLimit,
  storeOTP,
  verifyOTP
};
