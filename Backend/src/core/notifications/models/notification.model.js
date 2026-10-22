import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema(
    {
        /**
         * Which product the notification belongs to.
         *
         * Added when the four verticals' inboxes were unified. Defaults to 'food' so
         * every existing document reads back exactly as it did.
         */
        vertical: {
            type: String,
            enum: ['food', 'quickCommerce', 'taxi', 'serviceProvider'],
            default: 'food',
            index: true
        },

        ownerType: {
            type: String,
            // VENDOR/WORKER come from service-provider, DRIVER from taxi. Kept as one
            // list rather than per-vertical enums so an inbox query never has to know
            // which vertical a recipient belongs to.
            enum: ['USER', 'RESTAURANT', 'DELIVERY_PARTNER', 'VENDOR', 'WORKER', 'DRIVER', 'ADMIN'],
            required: true,
            index: true
        },
        ownerId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            index: true
        },
        title: {
            type: String,
            required: true,
            trim: true
        },
        message: {
            type: String,
            required: true,
            trim: true
        },
        link: {
            type: String,
            default: '',
            trim: true
        },
        category: {
            type: String,
            default: 'broadcast',
            trim: true
        },
        source: {
            type: String,
            // SUPPORT_RESPONSE came from quick-commerce, which had drifted ahead of food.
            enum: ['ADMIN_BROADCAST', 'FSSAI_EXPIRY', 'SUPPORT_RESPONSE', 'BOOKING', 'RIDE', 'ORDER', 'PAYMENT', 'SYSTEM'],
            default: 'ADMIN_BROADCAST',
            index: true
        },
        broadcastId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'BroadcastNotification',
            default: null,
            index: true
        },
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },
        isRead: {
            type: Boolean,
            default: false,
            index: true
        },
        readAt: {
            type: Date,
            default: null
        },
        dismissedAt: {
            type: Date,
            default: null,
            index: true
        }
    },
    {
        collection: 'food_notifications',
        timestamps: true
    }
);

notificationSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
notificationSchema.index({ ownerType: 1, ownerId: 1, isRead: 1, dismissedAt: 1 });
notificationSchema.index({ broadcastId: 1, ownerType: 1, ownerId: 1 }, { unique: true, sparse: true });

export const NOTIFICATION_VERTICALS = Object.freeze(['food', 'quickCommerce', 'taxi', 'serviceProvider']);

export { notificationSchema };

export const FoodNotification = mongoose.models.FoodNotification || mongoose.model('FoodNotification', notificationSchema);
