/** Parse a CSV body into the row objects the importers expect.
 *
 * Lives here rather than in actions.ts because a "use server" module
 * may only export async functions — everything in it becomes a
 * callable server action, and a sync helper is not one.
 */
export type ImportRow = {
  row_number: number;
  sku_code: string | null;
  status: string;
  message: string | null;
};

/**
 * What a header cell might say, and what it means here.
 *
 * ── Why aliases exist ──
 *
 * Nobody types a CSV. It comes out of Excel, or a supplier's price
 * list, or the last system the shop used, and the column is called
 * "Product Name" or "MRP (₹)" or "Selling Price". The old importer
 * matched `name` exactly and silently ignored everything else — so a
 * perfectly good file imported as a hundred rows with no name, each
 * failing with "name is required", and the fix was to retype the
 * header by hand.
 *
 * Matching is done on a squashed key: lowercased, with everything that
 * is not a letter or digit removed. So "MRP (₹)", "mrp_", "M.R.P." and
 * "Mrp" are one alias, and the table below stays readable.
 */
const ALIASES: Record<string, string> = {
  // identity
  name: "name", productname: "name", product: "name", itemname: "name",
  item: "name", description: "description", desc: "description",
  sku: "sku_code", skucode: "sku_code", code: "sku_code", itemcode: "sku_code",

  // classification
  category: "category", categoryname: "category", group: "category",
  hsn: "hsn_code", hsncode: "hsn_code", hsnsac: "hsn_code",
  tax: "tax_rate", taxrate: "tax_rate", gst: "tax_rate", gstrate: "tax_rate",

  // units
  baseuom: "base_uom", uom: "base_uom", unit: "base_uom",
  baseunit: "base_uom", unitofmeasure: "base_uom",
  packsize: "pack_size", pack: "pack_size", packing: "pack_size",
  size: "pack_size", packunit: "pack_size",

  // handling
  trackingmode: "tracking_mode", tracking: "tracking_mode",
  shelflifedays: "shelf_life_days", shelflife: "shelf_life_days",
  expirydays: "shelf_life_days",
  isweighed: "is_weighed", weighed: "is_weighed", loose: "is_weighed",
  barcode: "barcode", ean: "barcode", barcodeean: "barcode",

  // money — rupees in the file, paise in the database
  retail: "retail", retailprice: "retail", price: "retail",
  sellingprice: "retail", sp: "retail", rate: "retail",
  mrp: "mrp", maximumretailprice: "mrp", printedprice: "mrp",
  wholesale: "wholesale", wholesaleprice: "wholesale", b2bprice: "wholesale",
  cost: "cost", costprice: "cost", purchaseprice: "cost", landedcost: "cost",

  // stock
  location: "location_code", locationcode: "location_code",
  shop: "location_code", store: "location_code", warehouse: "location_code",
  qty: "quantity", quantity: "quantity", onhand: "quantity",
  stock: "quantity", count: "quantity", openingstock: "quantity",
};

const squash = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Split one CSV line, honouring quoted fields that contain commas. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if ((ch === "," || ch === "\t") && !inQuotes) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Money as written by a human: "₹1,250.50", "1250.5", "1,250". */
function money(v: string): number | null {
  const n = Number(v.replace(/[₹$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export type ParsedCsv = {
  rows: Record<string, unknown>[];
  /** Header cells that matched no known field, so the page can say so. */
  ignored: string[];
  /** Which known fields the file actually supplies. */
  present: string[];
};

/**
 * Parse a CSV body.
 *
 * Unknown columns are REPORTED rather than dropped in silence. A file
 * with a "Selling Price" column the importer does not understand looks
 * identical to one without it, right up until the shop notices nothing
 * has a price.
 */
export function parseCsvDetailed(text: string): ParsedCsv {
  // A spreadsheet saved as CSV from Excel often carries a BOM, which
  // otherwise becomes part of the first header and stops it matching.
  const body = text.replace(/^﻿/, "");

  const lines = body.trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { rows: [], ignored: [], present: [] };

  const raw = splitLine(lines[0]);
  const ignored: string[] = [];
  const headers = raw.map((h) => {
    const key = ALIASES[squash(h)];
    if (!key && h.trim() !== "") ignored.push(h);
    return key ?? null;
  });

  const present = [...new Set(headers.filter((h): h is string => h !== null))];

  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const obj: Record<string, unknown> = {};

    headers.forEach((h, i) => {
      if (!h) return;
      const v = cells[i] ?? "";
      if (v === "") return;

      switch (h) {
        case "shelf_life_days":
        case "tax_rate":
        case "quantity":
          obj[h] = Number(v.replace(/[,\s]/g, ""));
          break;
        case "is_weighed":
          obj[h] = /^(true|yes|y|1)$/i.test(v);
          break;
        case "retail": case "mrp": case "wholesale": case "cost":
          obj[h] = money(v);
          break;
        case "base_uom":
        case "tracking_mode":
        case "location_code":
          obj[h] = v.toUpperCase();
          break;
        default:
          obj[h] = v;
      }
    });

    return obj;
  });

  return { rows, ignored, present };
}
