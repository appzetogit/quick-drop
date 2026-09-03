import multer from 'multer';

/**
 * Scoped to the home-header-video upload only -- the shared `middleware/upload.js`
 * has no size cap or mimetype filter at all, and widening it would change behaviour
 * for every other uploader that already relies on that leniency.
 */
const ALLOWED_MIME_TYPES = new Set([
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'image/gif'
]);

export const uploadHeaderMedia = multer({
    storage: multer.memoryStorage(),
    // A short, width-capped clip encodes well under this. Generous enough for a
    // phone-camera clip, not so generous that a low-frequency admin route becomes
    // a way to buffer multi-minute video into process memory.
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
            return cb(new Error('Unsupported file type. Upload MP4, MOV, WebM, or GIF.'));
        }
        cb(null, true);
    }
});
