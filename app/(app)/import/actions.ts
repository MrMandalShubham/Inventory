"use server";

import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";
import { withSession, withRollback } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { parseCsvDetailed } from "@/lib/csv";
import { importProducts, importStock, NO_COUNTS, type ResultRow, type Counts }
  from "@/lib/import";

/**
 * The import screen's one entry point.
 *
 * ── Why a POST, and why this replaced a GET ──
 *
 * The form used to submit the CSV as a query string. That works for
 * the eight-row sample the page shipped with and fails for the only
 * file anyone actually has: a URL has a practical ceiling of a few
 * thousand characters, and past it the request is truncated or refused
 * by the server before any code here runs. A thousand-row price list
 * could not be imported through the import screen.
 *
 * ── Preview is the import, rolled back ──
 *
 * A preview that re-implements the rules is a preview that disagrees
 * with them. The rules here are constraints, triggers and a CHECK on
 * nearly every column, so the honest way to know what a file will do
 * is to do it and throw it away. See withRollback.
 */

export type ImportResult = {
  kind: "products" | "stock";
  mode: "preview" | "commit";
  csv: string;
  fatal?: string;
  ignored: string[];
  rows: ResultRow[];
  counts: Counts;
};

/** Read the CSV from whichever input the operator used. */
async function readCsv(form: FormData): Promise<string> {
  const file = form.get("file");

  // A file input that was left alone still arrives — as a zero-byte
  // File with an empty name. Treating that as "they chose a file"
  // would silently discard whatever they pasted instead.
  if (file && typeof file !== "string" && file.size > 0) {
    return await file.text();
  }
  return String(form.get("csv") ?? "");
}

export async function runImport(_prev: unknown, form: FormData): Promise<ImportResult> {
  const kind = form.get("kind") === "stock" ? "stock" as const : "products" as const;
  const mode = form.get("mode") === "commit" ? "commit" as const : "preview" as const;

  const csv = await readCsv(form);
  const base = {
    kind, mode, csv, ignored: [] as string[],
    rows: [] as ResultRow[], counts: { ...NO_COUNTS },
  };

  if (!csv.trim()) {
    return { ...base, fatal: "Nothing to import — paste some rows or choose a file." };
  }

  const parsed = parseCsvDetailed(csv);

  if (parsed.rows.length === 0) {
    return { ...base, ignored: parsed.ignored,
      fatal: "No data rows. The first line must be the header, with at least one row under it." };
  }

  // Say what is missing BEFORE running a thousand rows that will each
  // fail for the same reason.
  const required = kind === "products" ? ["name"] : ["location_code", "quantity"];
  const missing = required.filter((f) => !parsed.present.includes(f));

  if (missing.length > 0) {
    return { ...base, ignored: parsed.ignored,
      fatal: `The file has no ${missing.join(" and no ")} column.` +
             (parsed.ignored.length
               ? ` These headers were not recognised: ${parsed.ignored.join(", ")}.`
               : "") };
  }

  if (kind === "stock" && !parsed.present.includes("sku_code") && !parsed.present.includes("name")) {
    return { ...base, ignored: parsed.ignored,
      fatal: "The file must identify each product, by sku or by name." };
  }

  const claims = await currentClaims();
  const run = (c: PoolClient) =>
    kind === "products" ? importProducts(c, parsed.rows) : importStock(c, parsed.rows);

  try {
    const result = mode === "commit"
      ? await withSession(claims, run)
      : await withRollback(claims, run);

    if (mode === "commit") {
      revalidatePath("/products");
      revalidatePath("/stock");
    }

    return { kind, mode, csv, ignored: parsed.ignored, ...result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, ignored: parsed.ignored, fatal: msg.replace(/^[A-Z_]+:\s*/, "") };
  }
}
