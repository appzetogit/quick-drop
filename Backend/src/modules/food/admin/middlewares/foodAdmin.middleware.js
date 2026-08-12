import { ForbiddenError, AuthError } from '../../../../core/auth/errors.js';
import { FoodAdmin } from '../../../../core/admin/admin.model.js';
import { serializeAdminContext, hasAdminPermission } from '../../../../core/admin/adminHierarchy.service.js';

/**
 * Middleware to load and attach the serialized admin hierarchy context to the request.
 */
export const attachFoodAdminContext = async (req, res, next) => {
  try {
    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return next(new AuthError('Admin session not found'));
    }

    const admin = await FoodAdmin.findById(userId);
    if (!admin) {
      return next(new AuthError('Admin account not found'));
    }

    if (admin.isActive === false) {
      return next(new ForbiddenError('Your account has been deactivated'));
    }

    req.admin = admin;
    req.adminContext = serializeAdminContext(admin);
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Middleware to restrict access based on resource permission.
 * Checks for resource.read (GET/HEAD) or resource.write (POST/PUT/PATCH/DELETE).
 */
export const requireFoodResourceAccess = (resource, label = '') => {
  return (req, res, next) => {
    if (!req.admin) {
      return next(new AuthError('Admin context required'));
    }

    const method = req.method;
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const requiredAction = isRead ? 'read' : 'write';

    // Platform and Food Superadmins have full access
    const isSuper = req.adminContext.adminLevel === 'platform_superadmin' || 
                    (req.adminContext.adminLevel === 'food_superadmin' && req.adminContext.module === 'food');

    if (isSuper) {
      return next();
    }

    // Check specific permission
    const hasWrite = hasAdminPermission(req.admin, resource, 'write');
    if (requiredAction === 'write') {
      if (hasWrite) {
        return next();
      }
      
      const hasRead = hasAdminPermission(req.admin, resource, 'read');
      if (hasRead) {
        return next(new ForbiddenError(`You have read-only permission for ${label || resource}`));
      }
      return next(new ForbiddenError(`Access denied: requires write permission for ${label || resource}`));
    }

    // Read action check: write implies read
    const hasRead = hasWrite || hasAdminPermission(req.admin, resource, 'read');
    if (hasRead) {
      return next();
    }

    return next(new ForbiddenError(`Access denied: requires read permission for ${label || resource}`));
  };
};
