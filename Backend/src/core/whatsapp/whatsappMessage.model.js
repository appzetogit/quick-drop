import mongoose from 'mongoose';

/**
 * Every WhatsApp message the platform sends or receives, one row per Meta
 * message id (wamid). Incoming messages arrive through the webhook; outgoing
 * ones are recorded when sent (services/whatsapp.service.js) and their
 * sent / delivered / read / failed receipts land on the same row.
 *
 * `phone` is always the customer's side of the conversation (digits only, with
 * country code), so one query lists a whole conversation either way.
 */
const statusSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, required: true },
    error: { type: String, default: '' },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    wamid: { type: String, required: true, unique: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    phone: { type: String, required: true, index: true },
    contactName: { type: String, default: '' },
    // text, image, document, audio, video, location, button, interactive,
    // template, reaction, sticker, unknown...
    type: { type: String, default: 'unknown' },
    text: { type: String, default: '' },
    // received (in) | accepted, sent, delivered, read, failed (out)
    status: { type: String, default: '' },
    statusHistory: { type: [statusSchema], default: [] },
    error: { type: String, default: '' },
    // Business number the message went to / came from (Meta phone number id).
    phoneNumberId: { type: String, default: '' },
    // When Meta says it happened; createdAt is when we stored it.
    sentAt: { type: Date, default: null },
    // Incoming: the message object as Meta sent it (media ids, location...).
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    // Outgoing: who or what sent it ('admin:<id>', 'food-invoice', ...).
    sentBy: { type: String, default: '' },
    // Outgoing template messages: which template, and the campaign that sent it (if any).
    templateName: { type: String, default: '' },
    campaignId: { type: mongoose.Schema.Types.ObjectId, default: null },
    readByAdmin: { type: Boolean, default: false },
  },
  { timestamps: true, minimize: false },
);

schema.index({ phone: 1, createdAt: -1 });
schema.index({ createdAt: -1 });
schema.index({ direction: 1, readByAdmin: 1 });
schema.index({ campaignId: 1, status: 1 }, { partialFilterExpression: { campaignId: { $type: 'objectId' } } });

export const WhatsAppMessage = mongoose.models.WhatsAppMessage
  || mongoose.model('WhatsAppMessage', schema, 'whatsapp_messages');
