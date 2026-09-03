import mongoose from 'mongoose';

const homeHeaderVideoSchema = new mongoose.Schema(
    {
        // What the app actually renders.
        gifUrl: {
            type: String,
            required: true
        },
        // Original upload, kept so a future re-transform doesn't need a re-upload.
        sourceUrl: {
            type: String,
            required: true
        },
        sourcePublicId: {
            type: String,
            required: true
        },
        // The eager GIF derivative's own public_id, for targeted cleanup on delete.
        gifPublicId: {
            type: String
        },
        resourceType: {
            type: String,
            enum: ['video', 'image'],
            default: 'video'
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true
        }
    },
    {
        collection: 'food_home_header_videos',
        timestamps: true
    }
);

homeHeaderVideoSchema.index({ isActive: 1, createdAt: -1 });

export const HomeHeaderVideo = mongoose.model('HomeHeaderVideo', homeHeaderVideoSchema);
