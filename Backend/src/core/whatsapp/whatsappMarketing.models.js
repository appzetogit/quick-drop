import mongoose from 'mongoose';

/**
 * WhatsApp marketing: contacts (opt-in / opt-out), campaigns, one row per
 * campaign recipient, and the order-notification settings.
 *
 * Phones are digits only with country code (917012345678), the same form the
 * message log (whatsapp_messages) uses, so the two join on `phone`.
 */

const contactSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    name: { type: String, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // opted_in: said yes (or replied START). opted_out: replied STOP or an admin
    // turned promotions off. unknown: never asked either way.
    marketing: { type: String, enum: ['opted_in', 'opted_out', 'unknown'], default: 'unknown', index: true },
    marketingChangedAt: { type: Date, default: null },
    // Who changed it last: 'customer:STOP', 'customer:START', 'admin:<id>', 'import'.
    marketingChangedBy: { type: String, default: '' },
    lastInboundAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const WhatsAppContact = mongoose.models.WhatsAppContact
  || mongoose.model('WhatsAppContact', contactSchema, 'whatsapp_contacts');

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    template: {
      name: { type: String, required: true },
      language: { type: String, required: true },
      category: { type: String, default: '' },
      parameterFormat: { type: String, default: 'POSITIONAL' },
    },
    // Values for the template's variables. Each value may contain {name} or
    // {phone}, filled in per customer. header/body: { "<key>": "value" } where
    // key is "1", "2"... (positional) or the variable name (named).
    variables: {
      header: { type: mongoose.Schema.Types.Mixed, default: {} },
      body: { type: mongoose.Schema.Types.Mixed, default: {} },
      // { "<button index>": "url suffix" } for URL buttons with a variable.
      buttons: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    // Image / video / document header: Meta media id (uploaded through us) or a public link.
    headerMedia: {
      format: { type: String, default: '' },
      mediaId: { type: String, default: '' },
      link: { type: String, default: '' },
      filename: { type: String, default: '' },
    },
    audience: { type: mongoose.Schema.Types.Mixed, default: {} },
    // draft -> sending -> done | cancelled. 'paused_limit' while waiting for
    // Meta's 24-hour messaging limit to free up; it resumes on its own.
    status: {
      type: String,
      enum: ['draft', 'sending', 'paused_limit', 'done', 'cancelled'],
      default: 'draft',
      index: true,
    },
    totalRecipients: { type: Number, default: 0 },
    skippedOptedOut: { type: Number, default: 0 },
    createdBy: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);

export const WhatsAppCampaign = mongoose.models.WhatsAppCampaign
  || mongoose.model('WhatsAppCampaign', campaignSchema, 'whatsapp_campaigns');

const recipientSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, required: true },
    phone: { type: String, required: true },
    name: { type: String, default: '' },
    // pending -> sending -> sent | failed | skipped
    state: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'skipped'], default: 'pending' },
    wamid: { type: String, default: '' },
    error: { type: String, default: '' },
    claimedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: false },
);
recipientSchema.index({ campaignId: 1, phone: 1 }, { unique: true });
recipientSchema.index({ campaignId: 1, state: 1 });

export const WhatsAppCampaignRecipient = mongoose.models.WhatsAppCampaignRecipient
  || mongoose.model('WhatsAppCampaignRecipient', recipientSchema, 'whatsapp_campaign_recipients');

/**
 * One document (_id 'default'): which approved template goes out for each
 * order event, and whether it is switched on.
 *   events.<event> = { enabled, templateName, language, parameterFormat,
 *                      body: { key: '{order_id}' ... }, header: {...} }
 * Values may use {customer_name} {order_id} {amount} {store_name}.
 */
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'default' },
    events: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true, minimize: false },
);

export const WhatsAppNotificationSettings = mongoose.models.WhatsAppNotificationSettings
  || mongoose.model('WhatsAppNotificationSettings', settingsSchema, 'whatsapp_notification_settings');
