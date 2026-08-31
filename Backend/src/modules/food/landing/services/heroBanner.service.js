import { FoodHeroBanner } from '../models/heroBanner.model.js';
import {
    uploadMediaBufferDetailed,
    deleteStoredAsset,
} from '../../../../services/cloudinary.service.js';

export const listHeroBanners = async () => {
    return FoodHeroBanner.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
};

export const createHeroBannersFromFiles = async (files, meta = {}) => {
    if (!files || !files.length) {
        return [];
    }

    const results = [];

    for (const file of files) {
        try {
            // Media, not image: a hero banner may be a video, and the home page
            // renders <video> instead of <img> based on the resource type
            // recorded below. The store sniffs the buffer and writes video
            // through untouched.
            const uploadResult = await uploadMediaBufferDetailed(
                file.buffer,
                'food/hero-banners',
            );

            const banner = await FoodHeroBanner.create({
                imageUrl: uploadResult.secure_url,
                publicId: uploadResult.public_id,
                // Recorded at upload so deletion can target the right resource
                // type; Cloudinary cannot infer it from the public id alone.
                resourceType: uploadResult.resource_type === 'video' ? 'video' : 'image',
                title: meta.title,
                ctaText: meta.ctaText,
                ctaLink: meta.ctaLink,
                linkedRestaurantIds: meta.linkedRestaurantIds || [],
                sortOrder: meta.sortOrder ?? 0,
                isActive: true
            });

            results.push({ success: true, banner: banner.toObject() });
        } catch (error) {
            // Cloudinary rejects with a bare string or a plain object as often as
            // with an Error, so error.message alone reports "undefined" to the admin
            // and hides why the upload failed.
            const reason =
                typeof error === 'string'
                    ? error
                    : error?.message || error?.error?.message || 'Upload failed';
            results.push({ success: false, error: reason });
        }
    }

    return results;
};

export const deleteHeroBanner = async (id) => {
    const doc = await FoodHeroBanner.findById(id);
    if (!doc) {
        return { deleted: false };
    }

    if (doc.publicId) {
        // Best-effort: a missing file must not block deleting the record.
        await deleteStoredAsset(doc.publicId);
    }

    await doc.deleteOne();
    return { deleted: true };
};

export const updateHeroBannerOrder = async (id, sortOrder) => {
    const updated = await FoodHeroBanner.findByIdAndUpdate(
        id,
        { sortOrder },
        { new: true }
    ).lean();
    return updated;
};

export const toggleHeroBannerStatus = async (id, isActive) => {
    const updated = await FoodHeroBanner.findByIdAndUpdate(
        id,
        { isActive },
        { new: true }
    ).lean();
    return updated;
};

export const linkRestaurantsToHeroBanner = async (id, restaurantIds) => {
    const updated = await FoodHeroBanner.findByIdAndUpdate(
        id,
        { linkedRestaurantIds: restaurantIds },
        { new: true }
    ).lean();
    return updated;
};


