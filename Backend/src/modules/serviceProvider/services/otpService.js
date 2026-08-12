const Token = require('../models/Token');
const { generateOTP, generateToken } = require('../utils/generateOTP');
const { TOKEN_TYPES } = require('../utils/constants');

/**
 * Create OTP token
 * @param {Object} params - Token parameters
 * @returns {Promise<Object>} - Created token document
 */
const createOTPToken = async ({ userId, email, phone, type, expiryMinutes = 10 }) => {
  // Delete any existing unused tokens of the same type
  const query = { type, isUsed: false };
  if (userId) query.userId = userId;
  if (email) query.email = email;
  if (phone) query.phone = phone;

  await Token.deleteMany(query);

  // Generate OTP and token
  const otp = generateOTP(6);
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

  // Create token document
  const tokenDoc = await Token.create({
    userId: userId || null,
    email: email || null,
    phone: phone || null,
    type,
    token,
    otp,
    expiresAt
  });

  return {
    tokenDoc,
    otp,
    token
  };
};

/**
 * Verify OTP token
 * @param {Object} params - Verification parameters
 * @returns {Promise<Object>} - Verification result
 */
const verifyOTPToken = async ({ email, phone, otp, type }) => {
  const query = { type, otp, isUsed: false };
  if (email) query.email = email;
  if (phone) query.phone = phone;

  const tokenDoc = await Token.findOne(query);

  if (!tokenDoc) {
    return {
      success: false,
      message: 'Invalid or expired OTP'
    };
  }

  // Check if token is expired
  if (new Date() > tokenDoc.expiresAt) {
    await Token.deleteOne({ _id: tokenDoc._id });
    return {
      success: false,
      message: 'OTP has expired. Please request a new one.'
    };
  }

  // Check attempts
  if (tokenDoc.attempts >= 5) {
    await Token.deleteOne({ _id: tokenDoc._id });
    return {
      success: false,
      message: 'Maximum attempts exceeded. Please request a new OTP.'
    };
  }

  // Increment attempts
  tokenDoc.attempts += 1;
  await tokenDoc.save();

  return {
    success: true,
    tokenDoc
  };
};

/**
 * Mark token as used
 * @param {string} tokenId - Token document ID
 * @returns {Promise<void>}
 */
const markTokenAsUsed = async (tokenId) => {
  await Token.findByIdAndUpdate(tokenId, { isUsed: true });
};

/**
 * Get token by token string
 * @param {string} token - Token string
 * @param {string} type - Token type
 * @returns {Promise<Object>} - Token document
 */
const getTokenByString = async (token, type) => {
  return await Token.findOne({ token, type, isUsed: false });
};

module.exports = {
  createOTPToken,
  verifyOTPToken,
  markTokenAsUsed,
  getTokenByString
};

