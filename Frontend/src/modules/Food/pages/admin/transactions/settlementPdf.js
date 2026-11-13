/**
 * The settlement statement as a PDF, from the same figures the screen shows.
 * The PDF fonts have no ₹ sign, so amounts print as "Rs".
 */
const rs = (n) => `Rs ${(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "")
const MODE = { upi: "UPI", bank_transfer: "Bank transfer", cash: "Cash" }
const STATUS = { paid: "Paid", partial: "Partly paid", pending: "Pending", on_hold: "On hold", carried_forward: "Carried forward", nothing: "No orders" }

export async function downloadSettlementPdf(data) {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")])
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" })
  const W = doc.internal.pageSize.getWidth()
  const t = data.totals
  const showDeductions = t.deductions > 0

  doc.setFont("helvetica", "bold")
  doc.setFontSize(15)
  doc.text("QUICKDROPS INDIA", 14, 15)
  doc.setFontSize(11)
  doc.text("Food Partner Settlement Statement", 14, 21)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.text(`Generated ${new Date().toLocaleString("en-IN")}`, W - 14, 15, { align: "right" })

  const meta = [
    ["Restaurant", data.restaurant.name],
    ["GSTIN", data.restaurant.gstNumber || "-"],
    ["Settlement period", data.cycle.label],
    ["Settlement ID", data.settlement ? data.settlementNo : `${data.settlementNo} (not locked yet)`],
    ["Status", STATUS[data.status] || data.status],
  ]
  autoTable(doc, {
    startY: 26,
    body: meta,
    theme: "plain",
    styles: { fontSize: 9, cellPadding: 1 },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 38 } },
    margin: { left: 14 },
    tableWidth: 140,
  })

  const head = ["#", "Order date", "Order ID", "Basic", "Packing", "GST on bill", "Bill total", "Commission", ...(showDeductions ? ["Deductions*"] : []), "Payable"]
  const body = data.lines.map((l, i) => [
    i + 1,
    day(l.orderDate),
    l.orderNo,
    rs(l.basic),
    rs(l.packing),
    rs(l.gst),
    rs(l.billTotal),
    rs(l.commission),
    ...(showDeductions ? [rs(l.deductions)] : []),
    rs(l.payable),
  ])
  const foot = ["", "", `${t.orders} orders`, rs(t.basic), rs(t.packing), rs(t.gst), rs(t.billTotal), rs(t.commission), ...(showDeductions ? [rs(t.deductions)] : []), rs(t.payable)]
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 4,
    head: [head],
    body,
    foot: [foot],
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [30, 41, 59] },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: "bold" },
    columnStyles: Object.fromEntries(head.map((_, i) => [i, i >= 3 ? { halign: "right" } : {}])),
    margin: { left: 14, right: 14 },
  })

  const summary = [
    ["Total orders", String(t.orders)],
    ["Total basic amount", rs(t.basic)],
    ["Total packing charges", rs(t.packing)],
    ["Total GST", rs(t.gst)],
    ["Total bill amount", rs(t.billTotal)],
    ["Total commission", rs(t.commission)],
    ...(showDeductions ? [["Deductions*", rs(t.deductions)]] : []),
    ["Restaurant payable (this cycle)", rs(t.payable)],
    ...(data.carriedIn > 0 ? [["Brought forward from earlier cycles", rs(data.carriedIn)]] : []),
    ["Total paid", rs(data.paid)],
    ...(data.carriedOut > 0 ? [[`Carried forward to ${data.settlement?.carriedTo || "next cycle"}`, rs(data.carriedOut)]] : []),
    ["Total pending", rs(data.balance)],
  ]
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 6,
    head: [["Summary", ""]],
    body: summary,
    styles: { fontSize: 9, cellPadding: 1.6 },
    headStyles: { fillColor: [30, 41, 59] },
    columnStyles: { 1: { halign: "right" } },
    margin: { left: 14 },
    tableWidth: 120,
  })

  if (data.payments.length) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      head: [["Payment date", "Amount", "Mode", "Transaction ID / UTR", "Payment officer", "Recorded"]],
      body: data.payments.map((p) => [day(p.paidOn), rs(p.amount), MODE[p.mode] || p.mode, p.utr || "-", p.officerName || "-", `${day(p.recordedAt)} by ${p.recordedBy || "admin"}`]),
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: [30, 41, 59] },
      columnStyles: { 1: { halign: "right" } },
      margin: { left: 14, right: 14 },
    })
  }

  let y = doc.lastAutoTable.finalY + 6
  doc.setFontSize(8)
  doc.setTextColor(90)
  const notes = [
    "Bill total = Basic amount + Packing charges + GST on restaurant bill. Restaurant payable = Bill total - Commission.",
    ...(showDeductions ? ["* Deductions: GST on the food that Quickdrops pays to the government for this restaurant, and discounts the restaurant itself offered."] : []),
    "This is a system-generated statement.",
  ]
  for (const line of notes) {
    if (y > doc.internal.pageSize.getHeight() - 10) {
      doc.addPage()
      y = 15
    }
    doc.text(line, 14, y)
    y += 4.5
  }
  const name = data.restaurant.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")
  doc.save(`Settlement-${data.settlementNo}-${name}.pdf`)
}
