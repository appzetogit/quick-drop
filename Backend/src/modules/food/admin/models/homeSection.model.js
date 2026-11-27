import mongoose from 'mongoose';

/**
 * An admin-curated home section (a chip on the food home, next to the
 * hardcoded Trending / 99 Store / Buy-1-Get-1 ones).
 *
 * The admin picks the restaurants and dishes it contains and, optionally, the
 * zones it shows in. Empty `zoneIds` = every zone. The hardcoded chips in the
 * app are untouched; these render after them, ordered by `position`.
 */
const foodHomeSectionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    // Optional second word rendered in the accent colour (like "Now" / "Free").
    highlight: { type: String, default: '', trim: true },
    // A short icon hint the app maps to an icon, or an emoji. Optional.
    icon: { type: String, default: '', trim: true },
    // Optional chip styling, hex strings e.g. '#FFF0E6' / '#FF5200'.
    bgColor: { type: String, default: '' },
    textColor: { type: String, default: '' },
    // Empty = all zones. Otherwise only users in these zones see the section.
    zoneIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodZone', index: true }],
    restaurantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant' }],
    itemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FoodItem' }],
    position: { type: Number, default: 0, index: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    createdByRole: { type: String, enum: ['ADMIN'], default: 'ADMIN' },
  },
  { collection: 'food_home_sections', timestamps: true }
);

foodHomeSectionSchema.index({ status: 1, position: 1 });

export const FoodHomeSection = mongoose.model('FoodHomeSection', foodHomeSectionSchema);
