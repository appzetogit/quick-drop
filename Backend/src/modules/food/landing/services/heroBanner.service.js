import { FoodHeroBanner } from '../models/heroBanner.model.js';
import { v2 as cloudinary } from 'cloudinary';

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
            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    // 'auto' rather than 'image' so a hero banner can be a video.
                    // Cloudinary detects the type, stores a video under its own
                    // resource type, and returns a /video/upload/ URL -- which is
                    // what the home page keys on to render <video> instead of
                    // <img>. Pinned to 'image' this upload simply failed, so a
                    // video banner could not be created at all.
                    { folder: 'food/hero-banners', resource_type: 'auto' },
                    (error, result) => {
                        if (error) return reject(error);
                        return resolve(result);
                    }
                );
                stream.end(file.buffer);
            });

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
            results.push({ success: false, error: error.message });
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
        try {
            await cloudinary.uploader.destroy(doc.publicId, {
                resource_type: doc.resourceType === 'video' ? 'video' : 'image',
            });
        } catch {
            // ignore cloudinary deletion errors to avoid blocking deletion
        }
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


