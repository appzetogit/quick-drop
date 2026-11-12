/*
 * Shared by the Food orders list and Master > All orders, so the order view reads
 * the same fields wherever it is opened from.
 */

/** One order from the API, as the list, the order view and the exports read it. */
export const normalizeOrder = (order) => {
  const createdAtRaw = order.createdAt || order.created_at || order.orderDate || null
  const createdAtCandidate = createdAtRaw ? new Date(createdAtRaw) : null
  const createdAt =
    createdAtCandidate && !Number.isNaN(createdAtCandidate.getTime())
      ? createdAtCandidate
      : null
  const date = createdAt
    ? createdAt.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).toUpperCase()
    : ""
  const time = createdAt
    ? createdAt.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).toUpperCase()
    : ""

  const pricing = order.pricing || {}
  const subtotal = Number(pricing.subtotal || 0)
  const deliveryFee = Number(pricing.deliveryFee || 0)
  const platformFee = Number(pricing.platformFee || 0)
  const taxAmount = Number(pricing.tax || 0)
  const discountAmount = Number(pricing.discount || 0)
  const computedTotal = subtotal + deliveryFee + platformFee + taxAmount - discountAmount
  const totalAmount = Number(
    pricing.total != null ? pricing.total : computedTotal
  )

  const paymentMethod = order.payment?.method || order.paymentMethod || ""
  let paymentType = order.paymentType
  if (!paymentType) {
    if (paymentMethod === "cash" || paymentMethod === "cod") paymentType = "Cash on Delivery"
    else if (paymentMethod === "wallet") paymentType = "Wallet"
    else if (paymentMethod) paymentType = "Online"
    else paymentType = "N/A"
  }

  const paymentStatusRaw = order.payment?.status || ""
  let paymentStatus = order.paymentStatus
  if (!paymentStatus) {
    const s = String(paymentStatusRaw || "").toLowerCase()
    if (s === "refunded") paymentStatus = "Refunded"
    else if (s === "paid" || s === "authorized" || s === "captured" || s === "settled") paymentStatus = "Paid"
    else if (s === "failed") paymentStatus = "Failed"
    else paymentStatus = "Pending"
  }

  const backendStatus = String(order.orderStatus || "").toLowerCase()
  let displayStatus = order.orderStatus
  if (!backendStatus || backendStatus === "created" || backendStatus === "confirmed") {
    displayStatus = "Pending"
  } else if (backendStatus === "preparing" || backendStatus === "ready_for_pickup") {
    displayStatus = "Processing"
  } else if (backendStatus === "picked_up") {
    displayStatus = "Food On The Way"
  } else if (backendStatus === "delivered") {
    displayStatus = "Delivered"
  } else if (backendStatus === "cancelled_by_restaurant") {
    displayStatus = "Cancelled by Restaurant"
  } else if (backendStatus === "cancelled_by_user") {
    displayStatus = "Cancelled by User"
  } else if (backendStatus === "cancelled_by_admin") {
    displayStatus = "Canceled"
  } else if (backendStatus === "pending_payment") {
    // Online checkout opened but not paid; listed only on the All tab.
    displayStatus = "Awaiting Payment"
  }

  const dp = order.dispatch?.deliveryPartnerId
  const deliveryPartnerName =
    order.deliveryPartnerName ||
    dp?.name ||
    ""
  const deliveryPartnerPhone =
    order.deliveryPartnerPhone ||
    dp?.phone ||
    ""

  const items = Array.isArray(order.items)
    ? order.items.map((item) => ({
        quantity: item.quantity || 1,
        name: item.name || item.foodName || item.title || "Item",
        price: item.price || 0,
        // Kept so the list and the order view can show the size picked
        // (Full / Half) and add-ons; dropping them here hid them everywhere.
        variantName: item.variantName || item.variant?.name || "",
        addons: Array.isArray(item.addons) ? item.addons : [],
      }))
    : []

  const customerName = order.customerName || order.userId?.name || "N/A"
  const customerPhone = order.customerPhone || order.userId?.phone || "N/A"
  const restaurant =
    order.restaurant ||
    order.restaurantName ||
    order.restaurantId?.restaurantName ||
    ""

  return {
    ...order,
    id: order._id || order.id,
    orderId: order.orderId || order.id,
    date,
    time,
    customerName,
    customerPhone,
    restaurant,
    items,
    subtotal,
    totalItemAmount: subtotal,
    couponDiscount: discountAmount,
    itemDiscount: 0,
    deliveryCharge: deliveryFee,
    vatTax: taxAmount,
    platformFee,
    totalAmount,
    paymentType,
    paymentStatus,
    orderStatus: displayStatus,
    // The wire value, kept because orderStatus above is now a display label.
    rawOrderStatus: backendStatus,
    deliveryPartnerName,
    deliveryPartnerPhone,
    deliveryType: order.deliveryType || "Home Delivery",
    orderOtp: order.deliveryOtp,
    address: order.address || order.customerAddress || order.deliveryAddress,
    refundStatus: order.payment?.refund?.status || (order.payment?.status === 'refunded' ? 'processed' : null)
  }
}
