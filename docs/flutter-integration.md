# QuickDrop — Customer App Integration

Three backend changes are live on production. One of them is already returning
errors to real users on every order that trips it. The other two add fields the
app can safely ignore, but shouldn't.

| | Change | What the app must do |
|---|---|---|
| **Required** | Per-size quantity limits | Read limits from the selected size, not the dish. Checkout is rejecting orders today. |
| **Recommended** | Combos | Already orderable with no change. Two new fields let you show what's inside. |
| **Optional** | Free delivery by distance | The fee can be waived per platform *or* per restaurant. Read the reason and source from the pricing breakdown. |

- API base: `https://quickdropsindia.com/api/v1`
- Backend commit: `549221b`
- Every payload below is a real response captured from production, not an example.

---

## 1. Each size carries its own quantity limits — REQUIRED

Until now one pair of limits covered every size of a dish. A variant can now set
its own minimum and maximum, and **the server enforces the size's limits, not the
dish's**. An app that still reads the dish-level numbers will let someone build a
basket the server then refuses.

> **Happening now.** Production logs show repeated rejections on
> `POST /food/orders/calculate` reading *You can order at most 5 of "Pasta (Half
> Plate)"*. Those are real customers whose stepper let them reach a quantity the
> server would never accept.

### What arrives now

Every variant in `variants[]` gained two nullable fields:

```json
{
  "name": "Pasta",
  "price": 98,
  "variantsEnabled": true,
  "minOrderQuantity": 1,          // dish level
  "maxOrderQuantity": 10,         // dish level
  "variants": [
    {
      "_id": "6a99...58c0",
      "name": "Half Plate",
      "price": 98,
      "minOrderQuantity": null,   // inherits the dish's 1
      "maxOrderQuantity": 5       // its own cap, beats the dish's 10
    },
    {
      "_id": "6a99...58c1",
      "name": "Full Plate",
      "price": 180,
      "minOrderQuantity": 2,      // must order at least 2
      "maxOrderQuantity": 3
    }
  ]
}
```

### The three states, and the one that bites

Each field has three meanings, and they are not interchangeable:

- `null` — this size sets nothing. Fall back to the dish's value.
- `0` — **only valid on max.** It means "no cap of my own", so the platform
  ceiling applies. It does *not* mean a maximum of zero.
- Any positive number — that is the limit for this size.

> **The trap.** Dart's `??` falls through on `null` only, never on `0`. That is
> correct for the inherit rule and wrong for the cap rule. Writing
> `variant.max ?? item.max` then clamping to it turns a "no cap" zero into a
> stepper frozen at zero, and the dish becomes unorderable.

The two bounds also fall back **independently**. Half Plate above sets a max but
no min, so it keeps the dish's minimum of 1. Resolving them as a pair would
silently discard a minimum somebody set deliberately.

### Resolution, matching the server exactly

```dart
class QuantityLimits {
  final int min;
  final int max;
  const QuantityLimits({required this.min, required this.max});
}

/// Mirrors resolveOrderQuantityRules on the server. The server is still the
/// authority and will reject anything outside these bounds -- this exists so
/// the stepper never offers a quantity checkout would refuse.
const int kPlatformCeiling = 99;

QuantityLimits resolveQuantityLimits({
  required MenuItem item,
  Variant? selectedVariant,
}) {
  // A dish with variants switched off prices and limits from its own fields,
  // whatever the stored rows still say. variantsEnabled is tri-state: absent
  // counts as ON when the dish has variants.
  final sellsByVariants = item.variantsEnabled != false;
  final v = sellsByVariants ? selectedVariant : null;

  // Each bound falls back on its own. ?? is right here: only null inherits.
  final int? rawMin = v?.minOrderQuantity ?? item.minOrderQuantity;
  final int? rawMax = v?.maxOrderQuantity ?? item.maxOrderQuantity;

  final min = (rawMin != null && rawMin > 0) ? rawMin : 1;

  // 0 means "no cap of my own", NOT "max zero". Treat it as unlimited and
  // let the platform ceiling stand.
  final hasCap = rawMax != null && rawMax > 0;
  final max = hasCap ? rawMax.clamp(min, kPlatformCeiling) : kPlatformCeiling;

  return QuantityLimits(min: min, max: max);
}
```

### Wiring it into the UI

- **Re-resolve on every size change.** Switching Half Plate to Full Plate changes
  the bounds from 1–5 to 2–3. If the user had 4 in the cart, clamp it down and
  say so rather than letting checkout reject it later.
- **Open the stepper at `min`, not 1.** Full Plate starts at 2. An "Add" button
  that adds one puts the user in an invalid state immediately.
- **Disable the plus control at `max`** and show why. "Maximum 3 per order for
  Full Plate" beats a dead button.
- **Re-check on cart hydrate.** Limits can change while a cart sits. The server
  clamps on its side and returns an `adjustments[]` array; surface it instead of
  silently changing the basket.

**Error contract.** If a quantity slips through, `POST /food/orders/calculate`
returns `400` with a message already written for the customer, naming the size:
*You can order at most 3 of "Pasta (Full Plate)".* Show `message` verbatim rather
than a generic failure.

---

## 2. Combos are dishes made of other dishes — RECOMMENDED

A restaurant groups dishes it already sells — two at minimum — and offers them at
one fixed price. A combo is stored and served as an ordinary dish, so **it
already appears, prices and orders correctly with no app change at all**. What's
missing is the reason it looks cheap.

### What arrives now

Two fields were added to every dish in the feed and the restaurant menu. On a
normal dish they are `false` and `[]`.

```json
{
  "id": "6a99...58c7",
  "name": "Meal Deal",
  "description": "Burger + Fries + Coke",
  "price": 199,              // what the customer pays
  "basePrice": 250,          // what the parts cost separately
  "strikePrice": 250,
  "discountPercent": 20.4,
  "isCombo": true,
  "comboComponents": [
    { "itemId": "...b7", "name": "Burger", "variantName": "",
      "quantity": 1, "listUnitPrice": 150 },
    { "itemId": "...ba", "name": "Fries",  "variantName": "",
      "quantity": 1, "listUnitPrice": 60 },
    { "itemId": "...bc", "name": "Coke",   "variantName": "",
      "quantity": 1, "listUnitPrice": 40 }
  ],
  "variantsEnabled": false,   // combos never have sizes
  "foodType": "Veg"           // Non-Veg if any component is
}
```

### The model

```dart
class ComboComponent {
  final String itemId;
  final String name;
  final String variantName;
  final int quantity;
  final num listUnitPrice;

  const ComboComponent({
    required this.itemId,
    required this.name,
    required this.variantName,
    required this.quantity,
    required this.listUnitPrice,
  });

  factory ComboComponent.fromJson(Map<String, dynamic> j) => ComboComponent(
        itemId: j['itemId'] as String? ?? '',
        name: j['name'] as String? ?? '',
        variantName: j['variantName'] as String? ?? '',
        quantity: (j['quantity'] as num?)?.toInt() ?? 1,
        listUnitPrice: (j['listUnitPrice'] as num?) ?? 0,
      );

  /// "2 x Pizza (Large)" or "1 x Coke"
  String get label => variantName.isEmpty
      ? '$quantity x $name'
      : '$quantity x $name ($variantName)';
}

// On MenuItem.fromJson:
isCombo: json['isCombo'] == true,
comboComponents: ((json['comboComponents'] as List?) ?? const [])
    .map((e) => ComboComponent.fromJson(e as Map<String, dynamic>))
    .toList(),
```

### What to show

- **On the menu card:** a small "Combo" badge, and the saving. `basePrice - price`
  gives ₹51 here. The struck-through `basePrice` already renders if your card
  handles discounts, since a combo uses the same fields as any discounted dish.
- **On the detail sheet:** list `comboComponents` as "What's inside". This is the
  whole point of the change — without it the customer sees a cheap dish with an
  unexplained name.
- **In the cart and on the order:** the components under the line, unpriced. The
  money is on the combo line; a price beside each part reads as an extra charge.

### Do not

- Don't fetch the component dishes separately by `itemId`. The names in
  `comboComponents` are snapshots taken when the combo was saved, so they stay
  correct after a component is renamed, repriced or removed. Use `itemId` for
  deep-linking only, and expect it to sometimes point at a dish that no longer
  exists.
- Don't let the user edit what's in a combo, or add-ons per component. A combo is
  one line at one price. Add-ons attach to the combo itself, exactly as they do
  to any dish.

Availability is handled server-side: a combo leaves the menu automatically when
any component sells out, and returns when it comes back. You will simply stop
seeing it in the feed — no special handling needed.

---

## 3. Delivery can be free by distance and basket size — OPTIONAL

An admin can set a radius and a minimum order — say within 3 km on orders of ₹300
or more — and the delivery fee is waived when both hold. **The rule is off until
an admin enables it**, so nothing changes for you until then.

The rule can be set platform-wide *or* for one restaurant. A restaurant's own
setting beats the platform rule, including an explicit exclusion, so **there is
no single global rule the app can fetch and cache**. Two restaurants in the same
city can have different rules, or one can be excluded entirely while the
platform promotion runs. Always read it from the pricing response for the cart
in hand — never from a value you stored earlier.

### Where it surfaces

In the `pricing` object returned by `POST /food/orders/calculate`, under
`deliveryFeeBreakdown`:

```json
{
  "freeDeliveryApplied": true,
  "freeDeliveryReason": "distance_and_order_value",
  "freeDeliverySource": "restaurant",
  "freeDeliveryRule": {
    "maxDistanceKm": 3,
    "minOrderAmount": 300,
    "distanceKm": 2.1
  },
  "waivedDeliveryFee": 35,
  "appliedDeliveryFee": 0
}
```

`pricing.deliveryFee` is already `0` when this fires, so totals are correct
whether or not you read any of this. The breakdown exists so you can say *why*
delivery is free.

> **Two reasons, one flag.** `freeDeliveryApplied` is also set by the older
> per-dish rule, where every item in the basket is individually marked
> free-delivery. Check `freeDeliveryReason == 'distance_and_order_value'` to tell
> the new rule apart, and treat a missing reason as the per-dish case.

### Which rule paid

`freeDeliverySource` says where the applied rule came from. You do not need it
to price anything — totals are already correct — but it is there for analytics
and for copy that distinguishes a restaurant's own promotion from a platform
one.

| Value | Meaning |
|---|---|
| `platform` | The platform-wide rule applied. |
| `restaurant` | This restaurant's own rule applied, overriding the platform. |
| `restaurant_off` | This restaurant is excluded, even though the platform rule is running. |
| `none` | No rule is running at all. |

The last two appear alongside `freeDeliveryApplied: false`, so treat any value
other than `platform` or `restaurant` as "delivery is not free here".

### Badging a restaurant card

The restaurant list and restaurant detail now carry the offer each restaurant is
actually running, as `freeDeliveryOffer`, so a card can be badged before the
customer builds a basket.

```json
{
  "name": "Pizza Place",
  "freeDeliveryOffer": {
    "isEnabled": true,
    "maxDistanceKm": 7,
    "minOrderAmount": 150,
    "label": "Free delivery within 7 km on orders of ₹150 or more",
    "shortLabel": "Free delivery over ₹150"
  }
}
```

When no offer applies the object is simply `{ "isEnabled": false }` with no
numbers, so render the badge on `isEnabled` and never on the presence of the
key.

```dart
final offer = json['freeDeliveryOffer'] as Map<String, dynamic>?;
final hasOffer = offer?['isEnabled'] == true;
final badge = offer?['shortLabel'] as String? ?? '';
```

Use `shortLabel` on a card and `label` where there is room for the full terms.
Both are written server-side so the wording stays consistent with what checkout
says.

> **The badge states terms, not a promise.** The list has no delivery distance to
> test against, so it cannot know whether this customer is inside the radius —
> which is why the copy reads "within 7 km" rather than "you get free delivery".
> Whether it actually applies is settled by the pricing call at checkout. Do not
> reword the badge into a guarantee.

The internal mode a restaurant is set to is deliberately not exposed. A
restaurant excluded from a platform promotion returns `isEnabled: false`, the
same as one with no offer at all — there is nothing for the app to distinguish.

### The nudge, if you want it

When the customer is inside the radius but short of the minimum, telling them how
much more earns free delivery is worth real basket size.

```dart
/// Returns the rupees still needed, or null when there is nothing to say --
/// already earned it, too far away, or the rule is off.
num? freeDeliveryShortfall(Map<String, dynamic> pricing) {
  final b = pricing['deliveryFeeBreakdown'] as Map<String, dynamic>?;
  final rule = b?['freeDeliveryRule'] as Map<String, dynamic>?;
  if (rule == null) return null;
  if (b?['freeDeliveryApplied'] == true) return null; // already free

  final distance = rule['distanceKm'] as num?;
  final maxKm = rule['maxDistanceKm'] as num?;
  final minAmount = rule['minOrderAmount'] as num?;
  if (distance == null || maxKm == null || minAmount == null) return null;

  // Never nudge toward something unreachable: too far is too far, however
  // much they spend.
  if (distance > maxKm) return null;

  final subtotal = (pricing['subtotal'] as num?) ?? 0;
  final gap = minAmount - subtotal;
  return gap > 0 ? gap : null;
}
```

Copy that reads well: *Add ₹50 more for free delivery.* Compare against
`subtotal`, which is the food total before fees and tax — that is what the server
compares too.

---

## Field reference

Everything added, and where it appears. All fields are additive; nothing was
renamed or removed.

| Field | Type | Appears on | Meaning |
|---|---|---|---|
| `variants[].minOrderQuantity` | `int?` | feed, menu | `null` inherits the dish's minimum |
| `variants[].maxOrderQuantity` | `int?` | feed, menu | `null` inherits; `0` means no cap |
| `isCombo` | `bool` | feed, menu, order line | this dish is a bundle of other dishes |
| `comboComponents[]` | list | feed, menu, order line | empty on a normal dish |
| `comboComponents[].name` | `String` | — | snapshot, safe to display forever |
| `comboComponents[].variantName` | `String` | — | empty when no size was chosen |
| `comboComponents[].quantity` | `int` | — | per one combo, multiply by line quantity |
| `comboComponents[].listUnitPrice` | `num` | — | what this part costs on its own |
| `comboComponents[].allocatedLineTotal` | `num` | order line only | accounting share; don't show it |
| `deliveryFeeBreakdown.freeDeliveryApplied` | `bool` | pricing | the fee was waived, by either rule |
| `deliveryFeeBreakdown.freeDeliveryReason` | `String?` | pricing | `distance_and_order_value` for the new rule |
| `deliveryFeeBreakdown.freeDeliverySource` | `String?` | pricing | `platform`, `restaurant`, `restaurant_off`, `none` |
| `freeDeliveryOffer.isEnabled` | `bool` | restaurant list, detail | render the badge on this, not on the key |
| `freeDeliveryOffer.minOrderAmount` | `num` | restaurant list, detail | absent when no offer applies |
| `freeDeliveryOffer.maxDistanceKm` | `num` | restaurant list, detail | absent when no offer applies |
| `freeDeliveryOffer.shortLabel` | `String` | restaurant list, detail | card-sized copy |
| `freeDeliveryOffer.label` | `String` | restaurant list, detail | full terms |
| `deliveryFeeBreakdown.freeDeliveryRule` | `object?` | pricing | radius, minimum, and measured distance |
| `deliveryFeeBreakdown.waivedDeliveryFee` | `num` | pricing | what would otherwise have been charged |

**Endpoints, unchanged.** The cross-restaurant feed is
`GET /food/restaurant/public/foods`, a single restaurant's menu is
`GET /food/restaurant/restaurants/:id/menu`, and pricing is
`POST /food/orders/calculate`. Combos and per-size limits both flow through
these; no new endpoint is needed on the customer side.

---

## Before you ship

The first four are the ones that would reach a customer as a broken order.

- [ ] A dish whose variant sets `maxOrderQuantity: 0` is still orderable, and the
      stepper runs to the platform ceiling rather than freezing at zero.
- [ ] Switching from a size with limits 1–5 to one with 2–3 while 4 are in the
      cart clamps the quantity and tells the user.
- [ ] A variant with `minOrderQuantity: 2` opens its stepper at 2, and the first
      tap of "Add" puts 2 in the cart.
- [ ] A 400 from `/orders/calculate` shows the server's `message` verbatim,
      naming the size.
- [ ] A combo renders its components on the detail sheet, in the cart, and on the
      completed order.
- [ ] A combo shows its saving from `basePrice - price` and a struck-through
      original.
- [ ] A normal dish is unaffected: `isCombo` false, `comboComponents` empty, no
      badge, no "what's inside" section.
- [ ] Ordering a combo works end to end without any combo-specific cart logic.
- [ ] With the free-delivery rule off, the delivery line looks exactly as it does
      today.
- [ ] A restaurant with a free-delivery offer shows a badge from
      `freeDeliveryOffer.shortLabel`, and one without shows nothing.
- [ ] The free-delivery rule is read from each pricing response, never cached
      globally — two restaurants can have different rules, and one can be
      excluded while the platform promotion runs.

---

Backend is deployed and verified against live data. If a field is missing in your
build, wait out the response cache — the public feed is cached for 5 minutes and
a restaurant's menu for 10.
