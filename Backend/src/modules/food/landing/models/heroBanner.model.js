import mongoose from 'mongoose';

const foodHeroBannerSchema = new mongoose.Schema(
    {
        imageUrl: {
            type: String,
            required: true
        },
        publicId: {
            type: String,
            required: true
        },
        /**
         * Which Cloudinary resource type the asset was stored as.
         *
         * Needed at deletion: cloudinary.uploader.destroy() assumes 'image', so a
         * video banner would have its database record removed while the file
         * stayed in Cloudinary forever -- and the error is swallowed, so nothing
         * would ever say so. Defaults to 'image' for every banner that predates
         * video support, which is what they all are.
         */
        resourceType: {
            type: String,
            enum: ['image', 'video'],
            default: 'image'
        },
        title: {
            type: String
        },
        ctaText: {
            type: String
        },
        ctaLink: {
            type: String
        },
        linkedRestaurantIds: {
            type: [mongoose.Schema.Types.ObjectId],
            ref: 'FoodRestaurant',
            default: []
        },
        sortOrder: {
            type: Number,
            default: 0,
            index: true
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true
        }
    },
    {
        collection: 'food_hero_banners',
        timestamps: true
    }
);

foodHeroBannerSchema.index({ isActive: 1, sortOrder: 1 });

export const FoodHeroBanner = mongoose.model('FoodHeroBanner', foodHeroBannerSchema);

