import express from 'express';
import { uploadImage } from '../controllers/upload.controller.js';
import { imageUpload, uploadRateLimiter } from '../middleware/upload.middleware.js';
import { authMiddleware } from '../../../core/auth/auth.middleware.js';

const router = express.Router();

// POST /v1/uploads/image?folder=food/users/profile
// multipart field: file (required)
/*
 * Authenticated, but deliberately not role-restricted: every panel that uploads
 * here only ever writes an image, and admin, restaurant and delivery accounts
 * all legitimately do so.
 *
 * This is quick-commerce's own copy of the upload route -- the food module has a
 * separate one, guarded at the same time. Closing only that one left this
 * reachable by anyone, which is a disk waiting to fill and lets the domain host
 * arbitrary pictures. The rate limiter below throttles a caller; it does not
 * establish who they are.
 */
router.post(
    '/image',
    authMiddleware,
    uploadRateLimiter,
    imageUpload.single('file'),
    uploadImage
);

export default router;
