import { withSession } from "@/lib/db";
import { currentClaims, CAN_PLAN } from "@/lib/session";
import { PageHeader, Notice } from "../ui";
import { ImportForm } from "./import-form";

export const dynamic = "force-dynamic";

/**
 * Import products, or opening stock.
 *
 * ── What changed, and why ──
 *
 * The old screen posted the CSV as a QUERY STRING. That works for the
 * eight-row sample it shipped with and fails for the only file anyone
 * really has: past a few thousand characters the URL is truncated or
 * refused before any code runs. The screen could not import a price
 * list.
 *
 * It also had no preview, so the first time you learned a file was
 * wrong was after it had landed; no file picker, so a .csv had to be
 * opened in an editor and pasted; no price columns, so an imported
 * product could not be sold until somebody priced it by hand; and a
 * sample using category names that no longer exist, which quietly
 * created new categories outside the storefront's ten.
 *
 * The templates below are generated from the live catalogue rather
 * than hardcoded — a sample that goes stale teaches the wrong thing
 * with full confidence.
 */
export default async function ImportPage() {
  const me = await currentClaims();
  const canImport = CAN_PLAN.includes(me.role);

  const data = await withSession(me, async (c) => ({
    categories: (await c.query(
      `select id, name from catalog.category
        where status = 'ACTIVE' order by position, name`)).rows,
    uoms: (await c.query("select code from catalog.uom order by code")).rows.map((r) => r.code),
    locations: (await c.query(
      `select code from platform.location
        where status = 'ACTIVE' and type <> 'VIRTUAL' order by code`)).rows.map((r) => r.code),
    sample: (await c.query(
      `select p.sku_code, p.name, l.code as location
         from catalog.product p
         cross join lateral (
           select code from platform.location
            where status='ACTIVE' and type <> 'VIRTUAL' order by code limit 1) l
        where p.status = 'ACTIVE' order by p.sku_code limit 2`)).rows,
  }));

  const cat = data.categories[0]?.name ?? "Atta, Rice & Dal";
  const loc = data.locations[0] ?? "HUB";

  const templates = {
    products: [
      "name,category,base_uom,pack_size,tracking_mode,shelf_life_days,hsn_code,tax_rate,retail,mrp,wholesale,barcode",
      `Haldi Powder 200g,${cat},G,200 g,BATCH,540,0910,5,58,64,52,`,
      `Jeera Whole 100g,${cat},G,100 g,BATCH,540,0909,5,68,75,61,`,
      `Ajwain 100g,${cat},G,100 g,BATCH,540,0910,5,45,50,40,`,
    ].join("\n"),

    stock: [
      "sku,location,quantity,cost",
      ...(data.sample.length > 0
        ? data.sample.map((s: any) => `${s.sku_code},${s.location},2000,14`)
        : [`PRD-2026-000001,${loc},2000,14`]),
    ].join("\n"),
  };

  return (
    <>
      <PageHeader
        title="Import"
        lede={
          <>
            Bring in a spreadsheet — products, or the stock already sitting on a shelf.
            Every file is checked and shown to you before anything is written.
          </>
        }
      />

      {!canImport && (
        <div className="mb-4">
          <Notice tone="bad" title={`${me.full_name} cannot import.`}>
            Only a planner or admin may. The preview still works — the refusal comes from
            the database when you try to commit, not from this page.
          </Notice>
        </div>
      )}

      <div className="mb-4">
        <Notice tone="info" title="One bad row never stops the rest.">
          Each row is applied in its own sub-block, so the good ones land and the bad ones
          come back with a line number and a reason. A five-thousand-row file always has bad
          rows, and all-or-nothing would mean fixing one, re-running, and finding the next —
          five thousand times.
        </Notice>
      </div>

      <ImportForm
        templates={templates}
        categories={data.categories}
        uoms={data.uoms}
        locations={data.locations}
        canImport={canImport}
      />
    </>
  );
}
