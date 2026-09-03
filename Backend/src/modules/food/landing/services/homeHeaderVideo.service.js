import { HomeHeaderVideo } from '../models/homeHeaderVideo.model.js';
import { v2 as cloudinary } from 'cloudinary';

export const listHomeHeaderVideos = async () => {
    return HomeHeaderVideo.find().sort({ createdAt: -1 }).lean();
};

export const getActiveHomeHeaderVideo = async () => {
    return HomeHeaderVideo.findOne({ isActive: true }).sort({ createdAt: -1 }).lean();
};

/**
 * Uploads as a Cloudinary video resource -- covers mp4/mov/webm and, since
 * Cloudinary treats an uploaded GIF as a video-class resource too, a
 * directly-uploaded GIF passes through the same eager transformation with no
 * special-case branch. The eager transformation is what actually produces the
 * compressed, width-capped GIF the app renders; nothing here hand-rolls
 * conversion or compression.
 */
export const createHomeHeaderVideo = async (file) => {
    if (!file) return null;

    try {
        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: 'food/home-header-video',
                    resource_type: 'video',
                    eager: [
                        {
                            format: 'gif',
                            width: 800,
                            crop: 'limit',
                            fps: '10-15',
                            quality: 'auto:eco',
                            duration: 6
                        }
                    ],
                    eager_async: false
                },
                (error, result) => {
                    if (error) return reject(error);
                    return resolve(result);
                }
            );
            stream.end(file.buffer);
        });

        const gifUrl = uploadResult.eager?.[0]?.secure_url;
        if (!gifUrl) {
            throw new Error('Cloudinary did not return a GIF derivative');
        }

        // Only one background is ever shown at once. Deactivating the previous
        // active upload keeps the public endpoint's read trivial (findOne) while
        // still leaving old uploads in place so an admin can reactivate one
        // instead of re-uploading.
        await HomeHeaderVideo.updateMany({ isActive: true }, { isActive: false });

        return await HomeHeaderVideo.create({
            gifUrl,
            sourceUrl: uploadResult.secure_url,
            sourcePublicId: uploadResult.public_id,
            gifPublicId: uploadResult.eager[0].public_id,
            resourceType: 'video',
            isActive: true
        });
    } catch (error) {
        throw new Error(`Home header video creation failed: ${error.message}`);
    }
};

export const deleteHomeHeaderVideo = async (id) => {
    const doc = await HomeHeaderVideo.findById(id);
    if (!doc) return { deleted: false };

    for (const publicId of [doc.sourcePublicId, doc.gifPublicId]) {
        if (!publicId) continue;
        try {
            await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
        } catch {
            // ignore cloudinary errors
        }
    }

    await doc.deleteOne();
    return { deleted: true };
};

export const toggleHomeHeaderVideoStatus = async (id, isActive) => {
    if (isActive) {
        // Same single-active invariant as creation: activating this one
        // deactivates whatever else was active.
        await HomeHeaderVideo.updateMany({ _id: { $ne: id }, isActive: true }, { isActive: false });
    }
    return HomeHeaderVideo.findByIdAndUpdate(id, { isActive }, { new: true }).lean();
};
