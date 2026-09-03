import mongoose from 'mongoose';

const adminAppSettingSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },
    wallet_setting: { type: mongoose.Schema.Types.Mixed, default: {} },
    tip_setting: { type: mongoose.Schema.Types.Mixed, default: {} },
    country: { type: mongoose.Schema.Types.Mixed, default: {} },
    onboarding_screens: { type: [mongoose.Schema.Types.Mixed], default: [] },
    /**
     * Reasons offered to a rider when they cancel a ride.
     *
     * Deliberately a field on this single settings document rather than its own
     * collection: the Atlas cluster is at its hard 500-collection ceiling, so
     * `mongoose.model(...)` for a new collection fails outright with
     * "cannot create a new collection". This is settings-shaped reference data
     * anyway — a short, admin-edited list read as a whole.
     *
     * Each entry: { id, reason, stage, audience, sort_order, status }
     */
    cancellation_reasons: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

export const AdminAppSetting =
  mongoose.models.TaxiAdminAppSetting || mongoose.model('TaxiAdminAppSetting', adminAppSettingSchema);
