import mongoose from 'mongoose';
import { FoodHomeSection } from '../models/homeSection.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';

const toObjIds = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((x) => String(x || '').trim())
    .filter((x) => mongoose.Types.ObjectId.isValid(x))
    .map((x) => new mongoose.Types.ObjectId(x));

/** Full shape for the admin panel (ids included, so it can pre-fill edits). */
const toAdminDto = (s) => ({
  id: String(s._id),
  title: s.title,
  highlight: s.highlight || '',
  icon: s.icon || '',
  bgColor: s.bgColor || '',
  textColor: s.textColor || '',
  zoneIds: (s.zoneIds || []).map(String),
  restaurantIds: (s.restaurantIds || []).map(String),
  itemIds: (s.itemIds || []).map(String),
  position: Number(s.position) || 0,
  status: s.status,
  restaurantCount: (s.restaurantIds || []).length,
  itemCount: (s.itemIds || []).length,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/** Slim shape for a user-facing chip. */
const toChipDto = (s) => ({
  id: String(s._id),
  title: s.title,
  highlight: s.highlight || '',
  icon: s.icon || '',
  bgColor: s.bgColor || '',
  textColor: s.textColor || '',
});

// ----------------------------------------------------------------- admin CRUD

export const createHomeSection = async (body = {}) => {
  const title = String(body.title || '').trim();
  if (!title) throw new ValidationError('Section title is required');
  const doc = await FoodHomeSection.create({
    title,
    highlight: String(body.highlight || '').trim(),
    icon: String(body.icon || '').trim(),
    bgColor: String(body.bgColor || '').trim(),
    textColor: String(body.textColor || '').trim(),
    zoneIds: toObjIds(body.zoneIds),
    restaurantIds: toObjIds(body.restaurantIds),
    itemIds: toObjIds(body.itemIds),
    position: Number(body.position) || 0,
    status: body.status === 'inactive' ? 'inactive' : 'active',
  });
  return toAdminDto(doc.toObject());
};

export const listHomeSectionsAdmin = async () => {
  const list = await FoodHomeSection.find({}).sort({ position: 1, createdAt: 1 }).lean();
  return { sections: list.map(toAdminDto) };
};

export const updateHomeSection = async (id, body = {}) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ValidationError('Invalid section id');
  const update = {};
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) throw new ValidationError('Section title is required');
    update.title = t;
  }
  if (body.highlight !== undefined) update.highlight = String(body.highlight).trim();
  if (body.icon !== undefined) update.icon = String(body.icon).trim();
  if (body.bgColor !== undefined) update.bgColor = String(body.bgColor).trim();
  if (body.textColor !== undefined) update.textColor = String(body.textColor).trim();
  if (body.zoneIds !== undefined) update.zoneIds = toObjIds(body.zoneIds);
  if (body.restaurantIds !== undefined) update.restaurantIds = toObjIds(body.restaurantIds);
  if (body.itemIds !== undefined) update.itemIds = toObjIds(body.itemIds);
  if (body.position !== undefined) update.position = Number(body.position) || 0;
  if (body.status !== undefined) update.status = body.status === 'inactive' ? 'inactive' : 'active';
  const doc = await FoodHomeSection.findByIdAndUpdate(id, update, { new: true }).lean();
  if (!doc) throw new NotFoundError('Section not found');
  return toAdminDto(doc);
};

export const deleteHomeSection = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ValidationError('Invalid section id');
  const res = await FoodHomeSection.deleteOne({ _id: id });
  if (!res.deletedCount) throw new NotFoundError('Section not found');
  return { deleted: true };
};

// ------------------------------------------------------------------ user-side

/**
 * Active sections to show the user as chips, filtered to their zone. A section
 * with no zones is shown everywhere; a zone-scoped section needs the user's
 * zone to match. Empty sections (no restaurants and no dishes) are skipped.
 */
export const listHomeSectionsForUser = async ({ zoneId } = {}) => {
  const list = await FoodHomeSection.find({
    status: 'active',
    $or: [
      { restaurantIds: { $exists: true, $not: { $size: 0 } } },
      { itemIds: { $exists: true, $not: { $size: 0 } } },
    ],
  })
    .sort({ position: 1, createdAt: 1 })
    .lean();

  const zid = zoneId && mongoose.Types.ObjectId.isValid(zoneId) ? String(zoneId) : null;
  const visible = list.filter((s) => {
    const zones = (s.zoneIds || []).map(String);
    if (!zones.length) return true; // all zones
    return zid ? zones.includes(zid) : false; // zone-scoped: needs a match
  });
  return { sections: visible.map(toChipDto) };
};

/**
 * One section's curated restaurants + dishes, in the exact shapes the app's
 * restaurant list and dish list already parse (so it reuses those widgets).
 * Dishes are fetched without a zone filter so an admin-picked dish always
 * shows; the section's own zone scoping is applied at the chip level above.
 */
export const getHomeSectionDetail = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ValidationError('Invalid section id');
  const section = await FoodHomeSection.findOne({ _id: id, status: 'active' }).lean();
  if (!section) throw new NotFoundError('Section not found');

  const { listApprovedRestaurants } = await import(
    '../../restaurant/services/restaurant.service.js'
  );
  const { listPublicFoods } = await import(
    '../../restaurant/services/publicFoods.service.js'
  );

  const restaurantIds = (section.restaurantIds || []).map(String);
  const itemIds = (section.itemIds || []).map(String);

  const [restaurantsRes, foodsRes] = await Promise.all([
    restaurantIds.length
      ? listApprovedRestaurants({ restaurantIds, limit: 1000 })
      : Promise.resolve({ restaurants: [] }),
    itemIds.length
      ? listPublicFoods({ itemIds, limit: 1000 })
      : Promise.resolve({ foods: [] }),
  ]);

  return {
    id: String(section._id),
    title: section.title,
    highlight: section.highlight || '',
    restaurants: restaurantsRes.restaurants || [],
    foods: foodsRes.foods || [],
  };
};
