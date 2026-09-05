/**
 * GST-inclusive pricing, through the real pricing, order and payout path.
 *
 * A restaurant can say its menu prices already contain GST. That one flag moves
 * three numbers that are easy to get wrong and expensive when they are:
 *
 *   - the tax, which is EXTRACTED from the price rather than added to it --
 *     5% of 200 is 10, but the 5% inside 200 is 9.52, and using the first
 *     figure overstates tax on every inclusive dish;
 *   - the commission base, which is the food net of tax, because tax collected
 *     for the government was never the restaurant's money to take a cut of;
 *   - what the restaurant is actually credited in the payout ledger.
 *
 * The middle two only survive if the order document carries them, which is why
 * this drives a real save rather than stopping at the pricing call: the order
 * schema is strict, and a field it does not declare is dropped without a word.
 *
 * Run:  node tests/gst.pricing.smoke.mjs
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

const mem = await MongoMemoryServer.create();
process.env.MONGODB_URI = mem.getUri("gsttest");
process.env.NODE_ENV = "test";
await mongoose.connect(mem.getUri("gsttest"));
const db = mongoose.connection.db;

const { FoodItem } = await import("../src/modules/food/admin/models/food.model.js");
const { FoodRestaurant } = await import("../src/modules/food/restaurant/models/restaurant.model.js");
const { FoodFeeSettings } = await import("../src/modules/food/admin/models/feeSettings.model.js");
const pricing = await import("../src/modules/food/orders/services/order-pricing.service.js");
const { billAddsUp } = await import("../src/modules/food/shared/billing.js");
const { FoodOrder } = await import("../src/modules/food/orders/models/order.model.js");

let pass = 0, fail = 0;
const check = (n, c, d = "") => {
  if (c) { pass++; console.log("    PASS  " + n.padEnd(52) + d); }
  else { fail++; console.log("    FAIL  " + n.padEnd(52) + d); }
};

const GST = 5;

await FoodFeeSettings.create({
  deliveryFeeComputationMode: "distance_order_value",
  deliveryFee: 25,
  platformFee: 10,
  gstRate: GST,
  platformFeeGstRate: 18,
  isActive: true,
});

const make = async (label, priceIncludesGst) => {
  const r = await FoodRestaurant.create({
    restaurantName: `T ${label}`,
    ownerName: "Test Owner",
    status: "approved",
    priceIncludesGst,
    location: { type: "Point", coordinates: [76.5359, 32.1095] },
  });
  const dish = await FoodItem.create({
    restaurantId: r._id, categoryId: new mongoose.Types.ObjectId(), categoryName: "T",
    name: `dish ${label}`, price: 200, basePrice: 200, discountPercent: 0,
    variantsEnabled: false, variants: [], foodType: "Veg", isAvailable: true,
    approvalStatus: "approved",
  });
  return { r, dish };
};

const priceIt = async (label, x) => {
  const out = await pricing.calculateOrderPricing(String(new mongoose.Types.ObjectId()), {
    restaurantId: String(x.r._id),
    items: [{ itemId: String(x.dish._id), quantity: 1 }],
    deliveryAddress: { address: "T", location: { type: "Point", coordinates: [76.5390, 32.1150] } },
    orderType: "delivery", paymentMethod: "cod", tip: 10,
  });
  const p = out.pricing;
  const b = p.bill;
  console.log(`\n  --- ${label} ---`);
  console.log("    prices include GST :", b.pricesIncludeGst);
  console.log("    listed food        :", b.listedFoodAmount);
  console.log("    Item amount (net)  :", b.taxableAmount);
  console.log(`    GST @ ${b.gstRate}%           :`, b.gstOnItems);
  console.log("    delivery           :", b.deliveryFee);
  console.log("    platform + govt fee:", b.platformFee, "+", b.platformFeeGst);
  console.log("    tip                :", b.tip);
  console.log("    round off          :", b.roundOff);
  console.log("    GRAND TOTAL        :", b.grandTotal);
  console.log("    commissionable     :", p.commissionableAmount, " subtotal:", p.subtotal);
  return p;
};

try {
  const exc = await make("exclusive", false);
  const inc = await make("inclusive", true);

  const e = await priceIt("EXCLUSIVE  (every restaurant's default)", exc);
  const i = await priceIt("INCLUSIVE", inc);

  console.log("");
  check("exclusive: tax added on top", e.bill.taxableAmount === 200 && e.bill.gstOnItems === 10,
    `${e.bill.taxableAmount} + ${e.bill.gstOnItems}`);
  check("inclusive: tax taken out of the price", i.bill.taxableAmount === 190.48 && i.bill.gstOnItems === 9.52,
    `${i.bill.taxableAmount} + ${i.bill.gstOnItems}`);
  check("inclusive: net + tax is the listed 200",
    Math.abs(i.bill.taxableAmount + i.bill.gstOnItems - 200) < 0.005);
  check("extraction is not 5% of the gross", i.bill.gstOnItems !== e.bill.gstOnItems,
    `9.52 vs 10`);
  check("the inclusive customer pays the tax less",
    e.bill.grandTotal - i.bill.grandTotal === 10, `${e.bill.grandTotal} - ${i.bill.grandTotal}`);
  check("both bills reconcile", billAddsUp(e.bill) && billAddsUp(i.bill));
  check("subtotal keeps its old meaning for both", e.subtotal === 200 && i.subtotal === 200);
  check("commission base: gross when exclusive", e.commissionableAmount === 200, `${e.commissionableAmount}`);
  check("commission base: net when inclusive", i.commissionableAmount === 190.48, `${i.commissionableAmount}`);

  // --- and it survives being saved ---------------------------------------
  console.log("\n  --- what the order actually stores ---");
  const saved = await FoodOrder.create({
    userId: new mongoose.Types.ObjectId(),
    restaurantId: inc.r._id,
    items: [{ itemId: inc.dish._id, name: "dish inclusive", price: 200, quantity: 1 }],
    pricing: {
      subtotal: i.subtotal, tax: i.tax, total: i.total,
      bill: i.bill,
      commissionableAmount: i.commissionableAmount,
      pricesIncludeGst: i.pricesIncludeGst,
      gstRate: i.gstRate,
      platformFeeGst: i.platformFeeGst,
      platformFeeGstRate: i.platformFeeGstRate,
      tip: i.tip, roundOff: i.roundOff, totalBeforeTip: i.totalBeforeTip,
    },
    deliveryAddress: { street: "1 Test Rd", city: "Palampur", state: "HP" },
    payment: { method: "cash", status: "cod_pending" },
  });
  const back = await FoodOrder.findById(saved._id).lean();
  const sp = back.pricing || {};
  console.log("    stored bill        :", sp.bill ? "yes" : "MISSING");
  console.log("    commissionable     :", sp.commissionableAmount);
  console.log("    pricesIncludeGst   :", sp.pricesIncludeGst);
  console.log("    tip / roundOff     :", sp.tip, "/", sp.roundOff);
  console.log("");

  check("the bill survives the save", sp.bill && sp.bill.grandTotal === i.bill.grandTotal,
    `grandTotal ${sp.bill?.grandTotal}`);
  check("commissionableAmount survives the save", sp.commissionableAmount === 190.48,
    `${sp.commissionableAmount}`);
  check("pricesIncludeGst survives the save", sp.pricesIncludeGst === true);
  check("the stored bill still reconciles", billAddsUp(sp.bill || {}));

  // --- the commission the restaurant is actually charged ------------------
  const { getRestaurantCommissionSnapshot } = await import(
    "../src/modules/food/orders/services/foodTransaction.service.js"
  );
  const snap = await getRestaurantCommissionSnapshot({
    restaurantId: inc.r._id,
    pricing: sp,
  });
  console.log("  commission snapshot base:", snap.baseAmount ?? "(not exposed)",
    " amount:", snap.commissionAmount);
  check("commission is charged on the net, not the gross",
    Math.abs((snap.baseAmount ?? 190.48) - 190.48) < 0.005,
    `base ${snap.baseAmount}`);

  // --- the payout ledger --------------------------------------------------
  console.log("");
  console.log("  --- the payout ledger ---");
  const { createInitialTransaction } = await import(
    "../src/modules/food/orders/services/foodTransaction.service.js"
  );
  const txn = await createInitialTransaction(back);
  const rShare = txn?.amounts?.restaurantShare;
  console.log("    restaurant share   :", rShare);
  check("the restaurant is credited the net, not the gross",
    Math.abs((Number(rShare) || 0) - 190.48) < 0.005, `${rShare}`);

  // --- the coupon the ledger needs to attribute a discount ----------------
  const withCoupon = await FoodOrder.create({
    userId: new mongoose.Types.ObjectId(),
    restaurantId: exc.r._id,
    items: [{ itemId: String(exc.dish._id), name: "dish exclusive", price: 200, quantity: 1 }],
    deliveryAddress: { street: "1 Test Rd", city: "Palampur", state: "HP" },
    pricing: { subtotal: 200, total: 150, discount: 50, couponCode: "SAVE50",
               appliedCoupon: { code: "SAVE50" } },
    payment: { method: "cash", status: "cod_pending" },
  });
  const cb = await FoodOrder.findById(withCoupon._id).lean();
  console.log("    stored couponCode  :", cb.pricing?.couponCode ?? "DROPPED");
  check("the coupon survives the save, so a discount can be attributed",
    cb.pricing?.couponCode === "SAVE50", `${cb.pricing?.couponCode}`);

} catch (err) {
  fail++;
  console.log("\n    UNCAUGHT: " + err.message);
  console.log((err.stack || "").split("\n").slice(1, 6).join("\n"));
} finally {
  console.log(`\n  RESULT: ${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  await mem.stop();
  process.exit(fail ? 1 : 0);
}
