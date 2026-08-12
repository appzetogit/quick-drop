const { verifyAccessToken } = require('../utils/tokenService');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Worker = require('../models/Worker');
const Admin = require('../models/Admin');
const { USER_ROLES } = require('../utils/constants');
const { hasServiceProviderAccess } = require('../utils/serviceAccess');

/**
 * Authentication middleware - verifies JWT token
 */
const authenticate = async (req, res, next) => {
  try {
    // Get token from header
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.accessToken) {
      token = req.cookies.accessToken;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please login.'
      });
    }

    // Verify token
    let decoded;
    try {
      decoded = verifyAccessToken(token);
      // console.log('Decoded Token:', decoded); // Debug
    } catch (error) {
      console.error('Token verification failed:', error.message);
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token. Please login again.'
      });
    }

    // Get user based on role
    let user;
    // console.log('Role from token:', decoded.role); // Debug
    switch (decoded.role) {
      case USER_ROLES.USER:
        user = await User.findById(decoded.userId).select('-password').lean();
        break;
      case USER_ROLES.VENDOR:
        user = await Vendor.findById(decoded.userId).select('-password').lean();
        if (user && user.approvalStatus !== 'approved') {
          return res.status(403).json({
            success: false,
            message: 'Your vendor account is pending approval or has been rejected.'
          });
        }
        break;
      case USER_ROLES.WORKER:
        user = await Worker.findById(decoded.userId).select('-password').lean();
        break;
      case USER_ROLES.ADMIN:
      case 'super_admin':
      case 'admin':
      case 'ADMIN':
        user = await Admin.findById(decoded.userId).select('-password').lean();
        // `admins` is shared with the food and taxi modules, and their tokens are
        // signed with the same secret, so a food/taxi admin token verifies here.
        // Gate on service scope, not just on the token being valid.
        if (user && !hasServiceProviderAccess(user)) {
          return res.status(403).json({
            success: false,
            message: 'This account does not have Service Provider access.'
          });
        }
        break;
      default:
        console.error('Role mismatch in middleware:', decoded.role);
        return res.status(401).json({
          success: false,
          message: 'Invalid user role.'
        });
    }

    if (!user) {
      console.error('User not found for ID:', decoded.userId);
      return res.status(401).json({
        success: false,
        message: 'User not found. Please login again.'
      });
    }

    // SESSION INVALIDATION: logout sets loginSessionId to null and a new login
    // rotates it, so any token carrying a stale session id is dead. Tokens minted
    // before this shipped have no loginSessionId and are skipped until they expire.
    if (decoded.loginSessionId && user.loginSessionId !== decoded.loginSessionId) {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.'
      });
    }

    // Attach user to request
    // NOTE: .lean() removes the virtual .id getter — restore it manually
    req.user = { ...user, id: user._id.toString() };
    req.userId = decoded.userId;
    req.userRole = decoded.role;

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Authentication error. Please try again.'
    });
  }
};

module.exports = { authenticate };

