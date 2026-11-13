/**
 * The columns the product import reads, with the header names people actually
 * use for them. Headers are matched loosely: case, spaces and symbols ignored.
 */
export const IMPORT_COLUMNS = [
  { key: "name", label: "Product name", aliases: ["name", "product", "productname", "item", "itemname", "skuname"], required: true, example: ["Toor Dal", "Toor Dal", "Onion"] },
  { key: "size", label: "Size", aliases: ["size", "variant", "weight", "sizevariant"], example: ["500 g", "1 kg", ""] },
  { key: "category", label: "Category", aliases: ["category", "categoryname"], example: ["Dal & Pulses", "Dal & Pulses", "Vegetables"] },
  { key: "section", label: "Section", aliases: ["section"], example: ["Grocery", "Grocery", "Fruits & Vegetables"] },
  { key: "unit", label: "Unit", aliases: ["unit", "uom"], example: ["", "", "kg"] },
  { key: "brand", label: "Brand", aliases: ["brand"], example: ["Tata Sampann", "Tata Sampann", ""] },
  { key: "packSize", label: "Pack size", aliases: ["packsize"], example: ["", "", ""] },
  { key: "sku", label: "SKU", aliases: ["sku", "skucode", "code", "itemcode", "productcode"], example: ["TD500", "TD1000", ""] },
  { key: "barcode", label: "Barcode", aliases: ["barcode", "ean", "upc"], example: ["", "", ""] },
  { key: "mrp", label: "MRP", aliases: ["mrp"], example: ["90", "175", ""] },
  { key: "price", label: "Selling price", aliases: ["price", "sellingprice", "saleprice", "sp", "sellprice", "ourprice"], example: ["85", "165", "30"] },
  { key: "gstRate", label: "GST %", aliases: ["gst", "gstrate", "gstpercent", "tax", "taxrate", "salegst"], example: ["5", "5", "0"] },
  { key: "purchasePrice", label: "Purchase price", aliases: ["purchaseprice", "costprice", "cost", "buyprice", "purchaserate", "rate", "cp"], example: ["70", "136", "22"] },
  { key: "purchaseGstRate", label: "Purchase GST %", aliases: ["purchasegst", "purchasegstrate", "purchasegstpercent", "inputgst"], example: ["5", "5", "0"] },
  { key: "purchaseIncludesGst", label: "Purchase price includes GST", aliases: ["purchaseincludesgst", "purchasepriceincludesgst", "costincludesgst", "rateincludesgst", "inclgst", "includesgst"], example: ["No", "No", ""] },
  { key: "stock", label: "Stock", aliases: ["stock", "qty", "quantity", "stockqty", "opening", "openingstock", "instock"], example: ["20", "10", "12.5"] },
  { key: "lowStockAt", label: "Low stock alert", aliases: ["lowstock", "lowstockat", "lowstockalert", "alertat", "reorderlevel", "minstock"], example: ["5", "3", "2"] },
  { key: "foodType", label: "Veg / Non-veg", aliases: ["veg", "foodtype", "vegnonveg", "type"], example: ["Veg", "Veg", "Veg"] },
  { key: "description", label: "Description", aliases: ["description", "details"], example: ["", "", ""] },
]

const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")

/** Header row → { columnIndex: key }, plus the headers nobody reads. */
export function mapHeaders(headers) {
  const byAlias = new Map()
  for (const c of IMPORT_COLUMNS) for (const a of c.aliases) byAlias.set(a, c.key)
  const map = {}
  const unused = []
  const taken = new Set()
  headers.forEach((h, i) => {
    const key = byAlias.get(norm(h))
    if (key && !taken.has(key)) {
      map[i] = key
      taken.add(key)
    } else if (String(h ?? "").trim()) unused.push(String(h).trim())
  })
  return { map, found: [...taken], unused }
}

/** The first sheet of a workbook as product rows, skipping empty lines. */
export async function readProductSheet(file) {
  const XLSX = await import("xlsx")
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" })
  const ws = wb.Sheets[wb.SheetNames[0]]
  if (!ws) throw new Error("The file has no sheets")
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" })
  // The header is the first row that names a product column.
  const headerAt = grid.findIndex((r) => mapHeaders(r).found.includes("name"))
  if (headerAt < 0) throw new Error('No "Product name" column found. Download the template to see the columns.')
  const { map, found, unused } = mapHeaders(grid[headerAt])
  const rows = []
  for (const r of grid.slice(headerAt + 1)) {
    if (!r.some((v) => String(v).trim())) continue
    const row = {}
    for (const [i, key] of Object.entries(map)) {
      const v = String(r[i] ?? "").trim()
      if (v !== "") row[key] = v
    }
    rows.push(row)
  }
  return { rows, found, unused, sheet: wb.SheetNames[0] }
}

/** A filled-in example and a sheet explaining each column. */
export async function downloadTemplate() {
  const XLSX = await import("xlsx")
  const head = IMPORT_COLUMNS.map((c) => c.label)
  const examples = [0, 1, 2].map((i) => IMPORT_COLUMNS.map((c) => c.example[i] ?? ""))
  const products = XLSX.utils.aoa_to_sheet([head, ...examples])
  products["!cols"] = head.map((h) => ({ wch: Math.max(12, h.length + 2) }))
  const help = XLSX.utils.aoa_to_sheet([
    ["Column", "What to put"],
    ["Product name", "Required. A product already in the store (same name or same SKU) is updated; anything else is added."],
    ["Size", "For products sold in sizes (500 g, 1 kg): one row per size, same product name. Leave empty for a single product."],
    ["Category", "Required for new products. Must match a category that already exists."],
    ["Section", "Grocery, or Fruits & Vegetables. Empty = Grocery."],
    ["Unit", "kg, g, L, ml, dozen, or empty for pieces/packs. Fruits & vegetables default to kg."],
    ["MRP", "Printed MRP. The selling price cannot be above it."],
    ["Selling price", "Required for new products. What the customer pays."],
    ["GST %", "GST on the sale: 0, 5, 12, 18 or 28."],
    ["Purchase price", "What you pay the vendor for one (one pack, or one kg)."],
    ["Purchase GST %", "GST on the vendor's bill."],
    ["Purchase price includes GST", "Yes if the vendor's price already has GST in it. It is saved before GST."],
    ["Stock", "How many you have now. Decimals for kg (12.5). Empty = leave stock as it is."],
    ["Low stock alert", "Warn when stock falls to this number."],
    ["", ""],
    ["", "The three rows in the Products sheet are examples. Replace them with your products."],
  ])
  help["!cols"] = [{ wch: 30 }, { wch: 100 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, products, "Products")
  XLSX.utils.book_append_sheet(wb, help, "How to fill")
  XLSX.writeFile(wb, "quickdrop-products-template.xlsx")
}
