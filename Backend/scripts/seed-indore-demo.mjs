/**
 * Seed an EMPTY database with Indore demo data: zones, restaurants with menus,
 * grocery stores with products, and a pharmacy. Made-up names and numbers.
 *
 *   TARGET_URI=<mongodb uri> node scripts/seed-indore-demo.mjs          # dry run (validates only)
 *   TARGET_URI=<mongodb uri> node scripts/seed-indore-demo.mjs --apply
 *
 * Every document is written through the app's own models (so it is valid for
 * the app) and tagged demoSeed: 'indore-2026-09' so it can be removed with
 *   db.<collection>.deleteMany({ demoSeed: 'indore-2026-09' })
 * It refuses to write into a collection that already has documents.
 */
import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');
const TARGET_URI = process.env.TARGET_URI;
if (!TARGET_URI) throw new Error('TARGET_URI is required');
const TAG = 'indore-2026-09';

const { FoodZone } = await import('../src/modules/food/admin/models/zone.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
const { FoodCategory } = await import('../src/modules/food/admin/models/category.model.js');
const { FoodItem } = await import('../src/modules/food/admin/models/food.model.js');
const { FoodZone: QCZone } = await import('../src/modules/quickCommerce/modules/food/admin/models/zone.model.js');
const { FoodRestaurant: QCStore } = await import('../src/modules/quickCommerce/modules/food/restaurant/models/restaurant.model.js');
const { FoodCategory: QCCategory } = await import('../src/modules/quickCommerce/modules/food/admin/models/category.model.js');
const { FoodItem: QCItem } = await import('../src/modules/quickCommerce/modules/food/admin/models/food.model.js');

const oid = () => new mongoose.Types.ObjectId();
const now = new Date();
const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const img = (id) => `https://images.unsplash.com/${id}?w=800&q=70`;

// Indore, roughly Bhawarkua to Vijay Nagar and Rau to Palasia.
const INDORE_RING = [
  { latitude: 22.62, longitude: 75.76 },
  { latitude: 22.62, longitude: 75.96 },
  { latitude: 22.82, longitude: 75.96 },
  { latitude: 22.82, longitude: 75.76 },
];
const zoneDoc = (name) => ({ _id: oid(), name, zoneName: name, country: 'India', serviceLocation: 'Indore', unit: 'kilometer', boundary_mode: 'polygon', coordinates: INDORE_RING, isActive: true, demoSeed: TAG });

const place = (area, lat, lng, pincode) => ({
  addressLine1: `${area}, Indore`, area, city: 'Indore', state: 'Madhya Pradesh', pincode,
  location: { type: 'Point', coordinates: [lng, lat], latitude: lat, longitude: lng, formattedAddress: `${area}, Indore, Madhya Pradesh ${pincode}`, address: `${area}, Indore`, area, city: 'Indore', state: 'Madhya Pradesh', pincode },
});
let phoneSeq = 9000001000;
const seller = (name, owner, extra) => {
  phoneSeq += 1;
  return {
    _id: oid(), restaurantName: name, ownerName: owner, ownerEmail: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.jhatpat.in`,
    ownerPhone: String(phoneSeq), primaryContactNumber: String(phoneSeq),
    openingTime: '09:00', closingTime: '23:00', openDays: ALL_DAYS, isAcceptingOrders: true,
    status: 'approved', approvedAt: now, estimatedDeliveryTime: '30-35 mins', estimatedDeliveryTimeMinutes: 32,
    rating: 4.3, totalRatings: 120, demoSeed: TAG, ...extra,
  };
};

// ---------------- FOOD ----------------
const foodZone = zoneDoc('Indore');
const cats = {};
for (const [name, image] of [
  ['Street Food', img('photo-1601050690597-df0568f70950')], ['Breakfast', img('photo-1589301760014-d929f3979dbc')],
  ['Thali', img('photo-1585937421612-70a008356fbe')], ['Biryani', img('photo-1589302168068-964664d93dc0')],
  ['Pizza', img('photo-1513104890138-7c749659a591')], ['Burgers', img('photo-1568901346375-23c9450c58cd')],
  ['Beverages', img('photo-1571934811356-5cc061b6821f')], ['Desserts', img('photo-1551024601-bec78aea704b')],
]) cats[name] = { _id: oid(), name, image, type: 'food', approvalStatus: 'approved', isApproved: true, isActive: true, zoneId: foodZone._id, demoSeed: TAG };

const restaurants = [
  { r: seller('Sarafa Chaat Corner', 'Ramesh Jain', { ...place('Sarafa Bazaar', 22.7179, 75.8541, '452002'), pureVegRestaurant: true, cuisines: ['Street Food', 'Chaat'], closingTime: '23:59', coverImages: [img('photo-1601050690597-df0568f70950')], coverImage: img('photo-1601050690597-df0568f70950'), profileImage: img('photo-1601050690597-df0568f70950') }),
    items: [['Bhutte Ka Kees', 90, 'Street Food', 'Veg'], ['Garadu Chaat', 80, 'Street Food', 'Veg'], ['Dahi Vada', 70, 'Street Food', 'Veg'], ['Jalebi (250 g)', 120, 'Desserts', 'Veg'], ['Shikanji', 50, 'Beverages', 'Veg']] },
  { r: seller('Chappan Poha House', 'Sunita Verma', { ...place('56 Dukan, New Palasia', 22.7244, 75.8839, '452001'), pureVegRestaurant: true, cuisines: ['Breakfast', 'Street Food'], openingTime: '07:00', coverImages: [img('photo-1589301760014-d929f3979dbc')], coverImage: img('photo-1589301760014-d929f3979dbc'), profileImage: img('photo-1589301760014-d929f3979dbc') }),
    items: [['Indori Poha Jalebi', 60, 'Breakfast', 'Veg'], ['Upma', 70, 'Breakfast', 'Veg'], ['Khopra Pattice', 50, 'Street Food', 'Veg'], ['Masala Chai', 25, 'Beverages', 'Veg'], ['Shahi Shikanji', 60, 'Beverages', 'Veg']] },
  { r: seller('Malwa Rasoi', 'Anil Patidar', { ...place('Vijay Nagar', 22.7533, 75.8937, '452010'), pureVegRestaurant: true, cuisines: ['Thali', 'North Indian'], coverImages: [img('photo-1585937421612-70a008356fbe')], coverImage: img('photo-1585937421612-70a008356fbe'), profileImage: img('photo-1585937421612-70a008356fbe') }),
    items: [['Malwa Special Thali', 220, 'Thali', 'Veg'], ['Dal Bafla', 180, 'Thali', 'Veg'], ['Paneer Butter Masala', 240, 'Thali', 'Veg'], ['Gulab Jamun (2 pcs)', 60, 'Desserts', 'Veg'], ['Sweet Lassi', 70, 'Beverages', 'Veg']] },
  { r: seller('Rajwada Biryani House', 'Imran Qureshi', { ...place('Rajwada', 22.7185, 75.8553, '452004'), pureVegRestaurant: false, cuisines: ['Biryani', 'Mughlai'], coverImages: [img('photo-1589302168068-964664d93dc0')], coverImage: img('photo-1589302168068-964664d93dc0'), profileImage: img('photo-1589302168068-964664d93dc0') }),
    items: [['Chicken Dum Biryani', 260, 'Biryani', 'Non-Veg'], ['Mutton Biryani', 340, 'Biryani', 'Non-Veg'], ['Veg Biryani', 190, 'Biryani', 'Veg'], ['Chicken Kebab (6 pcs)', 220, 'Street Food', 'Non-Veg'], ['Phirni', 80, 'Desserts', 'Veg']] },
  { r: seller('Palasia Pizza Co.', 'Neha Agrawal', { ...place('Palasia', 22.7255, 75.8871, '452001'), pureVegRestaurant: true, cuisines: ['Pizza', 'Fast Food'], coverImages: [img('photo-1513104890138-7c749659a591')], coverImage: img('photo-1513104890138-7c749659a591'), profileImage: img('photo-1513104890138-7c749659a591') }),
    items: [['Margherita Pizza', 199, 'Pizza', 'Veg'], ['Farmhouse Pizza', 289, 'Pizza', 'Veg'], ['Paneer Tikka Pizza', 319, 'Pizza', 'Veg'], ['Garlic Bread', 129, 'Pizza', 'Veg'], ['Cold Coffee', 110, 'Beverages', 'Veg']] },
  { r: seller('Bhawarkua Burger Point', 'Rohit Sharma', { ...place('Bhawarkua', 22.6937, 75.8676, '452001'), pureVegRestaurant: false, cuisines: ['Burgers', 'Fast Food'], coverImages: [img('photo-1568901346375-23c9450c58cd')], coverImage: img('photo-1568901346375-23c9450c58cd'), profileImage: img('photo-1568901346375-23c9450c58cd') }),
    items: [['Aloo Tikki Burger', 79, 'Burgers', 'Veg'], ['Crispy Chicken Burger', 149, 'Burgers', 'Non-Veg'], ['Paneer Burger', 129, 'Burgers', 'Veg'], ['Peri Peri Fries', 99, 'Street Food', 'Veg'], ['Chocolate Shake', 120, 'Beverages', 'Veg']] },
];
const foodRestaurants = restaurants.map(({ r }) => ({ ...r, zoneId: foodZone._id }));
const foodItems = restaurants.flatMap(({ r, items }) => items.map(([name, price, cat, foodType]) => ({
  _id: oid(), restaurantId: r._id, categoryId: cats[cat]._id, categoryName: cat, name, price, foodType,
  description: `${name} from ${r.restaurantName}, Indore.`, image: cats[cat].image,
  isActive: true, isAvailable: true, approvalStatus: 'approved', approvedAt: now, demoSeed: TAG,
})));

// ---------------- QUICK & MEDICAL ----------------
const qcZone = zoneDoc('Indore Quick');
const medZone = zoneDoc('Indore Medical');
const qcCats = {};
for (const [name, image, type] of [
  ['Fruits & Vegetables', img('photo-1610832958506-aa56368176cf'), 'grocery'], ['Dairy & Bread', img('photo-1550583724-b2692b85b150'), 'grocery'],
  ['Atta, Rice & Dal', img('photo-1586201375761-83865001e31c'), 'grocery'], ['Snacks & Biscuits', img('photo-1621939514649-280e2ee25f60'), 'grocery'],
  ['Cold Drinks & Juices', img('photo-1581006852262-e4307cf6283a'), 'grocery'], ['Personal Care', img('photo-1556228578-8c89e6adf883'), 'grocery'],
  ['Medicines', img('photo-1584308666744-24d5c474f2ae'), 'medical'], ['Wellness & Supplements', img('photo-1607619056574-7b8d3ee536b2'), 'medical'],
]) qcCats[name] = { _id: oid(), name, image, type, approvalStatus: 'approved', isApproved: true, isActive: true, demoSeed: TAG };

const stores = [
  { r: seller('Vijay Nagar Daily Needs', 'Pankaj Gupta', { ...place('Vijay Nagar', 22.7512, 75.8952, '452010'), pureVegRestaurant: true, storeType: 'grocery', estimatedDeliveryTime: '10-15 mins', estimatedDeliveryTimeMinutes: 12, zoneId: qcZone._id }),
    items: [['Tomato (1 kg)', 40, 48, 'Fruits & Vegetables'], ['Onion (1 kg)', 35, 42, 'Fruits & Vegetables'], ['Banana (6 pcs)', 48, 60, 'Fruits & Vegetables'], ['Sanchi Milk (500 ml)', 30, 30, 'Dairy & Bread'], ['Brown Bread (400 g)', 45, 50, 'Dairy & Bread'], ['Paneer (200 g)', 90, 100, 'Dairy & Bread'], ['Aashirvaad Atta (5 kg)', 265, 299, 'Atta, Rice & Dal'], ['Basmati Rice (1 kg)', 120, 140, 'Atta, Rice & Dal'], ['Toor Dal (1 kg)', 160, 180, 'Atta, Rice & Dal'], ['Ratlami Sev (400 g)', 110, 120, 'Snacks & Biscuits'], ['Parle-G (800 g)', 85, 90, 'Snacks & Biscuits'], ['Coca-Cola (750 ml)', 40, 45, 'Cold Drinks & Juices'], ['Real Mango Juice (1 L)', 110, 125, 'Cold Drinks & Juices'], ['Dettol Soap (3 x 75 g)', 120, 135, 'Personal Care'], ['Colgate Toothpaste (200 g)', 105, 115, 'Personal Care']] },
  { r: seller('Indore Fresh Mart', 'Kavita Soni', { ...place('Rajendra Nagar', 22.6849, 75.8319, '452012'), pureVegRestaurant: true, storeType: 'supermarket', estimatedDeliveryTime: '15-20 mins', estimatedDeliveryTimeMinutes: 18, zoneId: qcZone._id }),
    items: [['Apple Shimla (1 kg)', 160, 190, 'Fruits & Vegetables'], ['Potato (1 kg)', 30, 36, 'Fruits & Vegetables'], ['Amul Butter (100 g)', 58, 60, 'Dairy & Bread'], ['Curd (400 g)', 45, 50, 'Dairy & Bread'], ['Sugar (1 kg)', 48, 52, 'Atta, Rice & Dal'], ['Moong Dal (1 kg)', 150, 170, 'Atta, Rice & Dal'], ['Lays Classic (52 g)', 20, 20, 'Snacks & Biscuits'], ['Namkeen Mixture (400 g)', 95, 110, 'Snacks & Biscuits'], ['Frooti (600 ml)', 35, 40, 'Cold Drinks & Juices'], ['Shampoo (340 ml)', 210, 240, 'Personal Care']] },
];
const pharmacies = [
  { r: seller('Palasia Medicos', 'Dr. Sanjay Mehta', { ...place('Palasia', 22.7262, 75.8885, '452001'), pureVegRestaurant: true, storeType: 'pharmacy', estimatedDeliveryTime: '20-25 mins', estimatedDeliveryTimeMinutes: 22, zoneId: medZone._id, openingTime: '08:00', closingTime: '23:30' }),
    items: [['Paracetamol 500 mg (15 tabs)', 25, 30, 'Medicines'], ['Cetirizine 10 mg (10 tabs)', 20, 22, 'Medicines'], ['ORS Sachet (pack of 5)', 90, 100, 'Medicines'], ['Antiseptic Liquid (250 ml)', 115, 125, 'Medicines'], ['Vitamin C Tablets (60)', 250, 299, 'Wellness & Supplements'], ['Digital Thermometer', 199, 250, 'Wellness & Supplements']] },
];
const qcStores = [...stores, ...pharmacies].map(({ r }) => r);
const qcItems = [...stores, ...pharmacies].flatMap(({ r, items }) => items.map(([name, price, mrp, cat]) => ({
  _id: oid(), restaurantId: r._id, categoryId: qcCats[cat]._id, categoryName: cat, name, price, mrp,
  description: name, image: qcCats[cat].image, foodType: 'Veg', stockQty: 100,
  isActive: true, isAvailable: true, approvalStatus: 'approved', approvedAt: now, demoSeed: TAG,
})));

// ---------------- WRITE ----------------
await mongoose.connect(TARGET_URI, { serverSelectionTimeoutMS: 20000 });
const db = mongoose.connection.db;
console.log(`target ${db.databaseName}${apply ? '' : '   (DRY RUN: validating only)'}`);

const plan = [
  [FoodZone, [foodZone]], [FoodCategory, Object.values(cats)], [FoodRestaurant, foodRestaurants], [FoodItem, foodItems],
  [QCZone, [qcZone]], [QCCategory, Object.values(qcCats)], [QCStore, qcStores], [QCItem, qcItems],
];
for (const [Model, docs] of plan) {
  const coll = Model.collection.collectionName;
  const existing = await db.collection(coll).estimatedDocumentCount();
  if (existing > 0) { console.log(`  SKIP ${coll}: already has ${existing} documents`); continue; }
  const built = docs.map((d) => new Model(d));
  for (const doc of built) { const err = doc.validateSync(); if (err) throw new Error(`${coll} ${doc.name || doc.restaurantName}: ${err.message}`); }
  if (apply) {
    // Model.create runs the pre-save hooks (normalised names, phone digits).
    for (const doc of built) { doc.set('demoSeed', TAG, { strict: false }); await doc.save(); }
    await db.collection(coll).updateMany({ _id: { $in: built.map((b) => b._id) } }, { $set: { demoSeed: TAG } });
  }
  console.log(`  ${apply ? 'wrote' : 'valid'} ${coll}: ${built.length}`);
}
// Medical zones have their own collection; same shape as the Quick zone.
const medColl = 'medical_zones';
if ((await db.collection(medColl).estimatedDocumentCount()) === 0) {
  if (apply) await db.collection(medColl).insertOne({ ...medZone, createdAt: now, updatedAt: now });
  console.log(`  ${apply ? 'wrote' : 'valid'} ${medColl}: 1`);
} else console.log(`  SKIP ${medColl}: not empty`);

if (apply) {
  for (const [Model] of plan) await Model.syncIndexes().catch((e) => console.log(`  index ${Model.collection.collectionName}: ${e.message}`));
}
await mongoose.disconnect();
console.log(apply ? 'done' : 'dry run ok -- re-run with --apply to write');
process.exit(0);
