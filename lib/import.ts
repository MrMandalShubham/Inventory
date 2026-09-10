import type { PoolClient } from "pg";

/**
 * What an import actually does, separated from the page that calls it.
 *
 * Lives here rather than in the server action so it can be tested
 * against a real database. A "use server" module may only export async
 * functions and is reachable as an RPC endpoint; importing it from a
 * test to check CSV handling would be testing the transport.
 */

export type ResultRow = {
  row: number;
  status: string;
  code: string | null;
  detail: string | null;
  extra: string | null;
};

export type Counts = { created: number; updated: number; failed: number; priced: number };

export const NO_COUNTS: Counts = { created: 0, updated: 0, failed: 0, priced: 0 };

export async function importProducts(
  c: PoolClient, rows: Record<string, unknown>[],
): Promise<{ rows: ResultRow[]; counts: Counts }> {
  const { rows: report } = await c.query(
    "select * from catalog.import_products($1::jsonb)", [JSON.stringify(rows)]);

  const counts = { ...NO_COUNTS };
  const out: ResultRow[] = [];

  for (const r of report) {
    if (r.status === "CREATED") counts.created += 1;
    else if (r.status === "UPDATED") counts.updated += 1;
    else counts.failed += 1;

    out.push({
      row: r.row_number, status: r.status,
      code: r.sku_code ?? null, detail: r.message ?? null, extra: null,
    });
  }

  // ── prices and pack sizes ──
  //
  // catalog.import_products knows about neither: one is a separate
  // table with its own MRP rule, the other is a display string. Doing
  // them here is what lets a single file produce a product that is
  // actually sellable, rather than one somebody still has to price by
  // hand before a storefront can show it.
  for (const [i, src] of rows.entries()) {
    const line = report[i];
    if (!line || line.status === "FAILED") continue;

    const { rows: found } = await c.query(
      "select id from catalog.product where sku_code = $1", [line.sku_code]);
    if (!found[0]) continue;

    if (src.pack_size) {
      await c.query("update catalog.product set pack_size = $2 where id = $1",
        [found[0].id, src.pack_size]);
    }

    const retail = src.retail as number | undefined;
    const mrp = src.mrp as number | undefined;
    if (!retail && !mrp) continue;

    // Both or neither. Selling above MRP is illegal, so a price
    // without its ceiling is not a price this system will hold — and
    // inventing the missing one is how a shop breaks the law because
    // of a spreadsheet.
    if (!retail || !mrp) {
      out[i].extra = "price skipped — needs both retail and mrp";
      continue;
    }

    try {
      await c.query("select catalog.set_price($1,$2,$3,$4)",
        [found[0].id, retail, mrp, (src.wholesale as number | undefined) ?? null]);
      counts.priced += 1;
      out[i].extra = `priced ₹${(retail / 100).toFixed(2)}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out[i].extra = `price refused — ${msg.replace(/^[A-Z_]+:\s*/, "")}`;
    }
  }

  return { rows: out, counts };
}

export async function importStock(
  c: PoolClient, rows: Record<string, unknown>[],
): Promise<{ rows: ResultRow[]; counts: Counts }> {
  // The importer wants a sku_code; a shopkeeper has a product name.
  // Resolving here rather than making somebody look up two hundred
  // codes is most of the point of the screen.
  const resolved: { index: number; row: Record<string, unknown> }[] = [];
  const unresolved: ResultRow[] = [];

  for (const [i, r] of rows.entries()) {
    let sku = r.sku_code as string | undefined;

    if (!sku && r.name) {
      const { rows: hit } = await c.query(
        "select sku_code from catalog.product where lower(name) = lower($1)", [r.name]);

      if (hit.length === 0) {
        unresolved.push({ row: i + 1, status: "FAILED", code: String(r.name),
          detail: "no product with that name — import the product first", extra: null });
        continue;
      }

      // Two products sharing a name is precisely the situation that
      // puts stock on the wrong one, silently. Refuse, and name both.
      if (hit.length > 1) {
        unresolved.push({ row: i + 1, status: "FAILED", code: String(r.name),
          detail: `${hit.length} products share this name (${hit.map((h: any) => h.sku_code).join(", ")}) — use the SKU`,
          extra: null });
        continue;
      }
      sku = hit[0].sku_code;
    }

    resolved.push({
      index: i,
      row: {
        sku_code: sku,
        location_code: r.location_code,
        on_hand: r.quantity,
        unit_cost_paise: r.cost ?? null,
      },
    });
  }

  const counts = { ...NO_COUNTS };
  counts.failed = unresolved.length;
  const out: ResultRow[] = [...unresolved];

  if (resolved.length > 0) {
    const { rows: report } = await c.query(
      "select * from stock.import_opening_balances($1::jsonb)",
      [JSON.stringify(resolved.map((r) => r.row))]);

    for (const [n, r] of report.entries()) {
      if (r.status === "FAILED") counts.failed += 1;
      else counts.created += 1;

      out.push({
        row: resolved[n].index + 1,
        status: r.status,
        code: r.sku_code ?? null,
        detail: r.message ?? null,
        extra: r.location ?? null,
      });
    }
  }

  out.sort((a, b) => a.row - b.row);
  return { rows: out, counts };
}
