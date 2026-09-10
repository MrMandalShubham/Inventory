import { withSession } from "@/lib/db";
import { currentClaims, CAN_PLAN } from "@/lib/session";
import { PageHeader, Notice } from "../ui";
import { ImportTabs } from "./tabs";
import { ReceiveForm } from "./receive-form";
import { ImportForm } from "./import-form";

export const dynamic = "force-dynamic";

/**
 * Import — a delivery, or a catalogue.
 *
 * ── Why these are two tabs and not one screen ──
 *
 * They were one screen, and it asked for twelve columns. But a
 * product's category, unit, HSN code, shelf life and tax rate are
 * decided ONCE, when the product is created. A delivery does not
 * restate them; it says how much of something already known turned up
 * and where it came from.
 *
 * Conflating the two made the weekly job carry the cost of the rare
 * one. Receiving is now three questions — where it arrived, where it
 * came from, and what was in it — and the spreadsheet lives on the
 * other tab, where it is the right tool for the rarer job of creating
 * a hundred products at once.
 */
export default async function ImportPage() {
  const me = await currentClaims();
  const canImport = CAN_PLAN.includes(me.role);

  const data = await withSession(me, async (c) => ({
    // Only locations this user may post to. The database would refuse
    // anything else, but offering a shop somebody cannot receive into
    // teaches them the wrong thing about their own permissions.
    locations: (await c.query(
      `select id, code, name from platform.location
        where status = 'ACTIVE' and type <> 'VIRTUAL' order by code`)).rows,
    categories: (await c.query(
      `select id, name from catalog.category
        where status = 'ACTIVE' order by position, name`)).rows,
    uoms: (await c.query("select code from catalog.uom order by code")).rows.map((r) => r.code),
  }));

  const cat = data.categories[0]?.name ?? "Atta, Rice & Dal";
  const locationCodes = data.locations.map((l: any) => l.code);

  const templates = {
    products: [
      "name,category,base_uom,pack_size,tracking_mode,shelf_life_days,hsn_code,tax_rate,retail,mrp,wholesale,barcode",
      `Haldi Powder 200g,${cat},G,200 g,BATCH,540,0910,5,58,64,52,`,
      `Jeera Whole 100g,${cat},G,100 g,BATCH,540,0909,5,68,75,61,`,
      `Ajwain 100g,${cat},G,100 g,BATCH,540,0910,5,45,50,40,`,
    ].join("\n"),

    stock: [
      "sku,location,quantity,cost",
      `PRD-2026-000001,${locationCodes[0] ?? "HUB"},2000,14`,
    ].join("\n"),
  };

  return (
    <>
      <PageHeader
        title="Import"
        lede="Receive a delivery, or load a spreadsheet of new products."
      />

      {!canImport && (
        <div className="mb-4">
          <Notice tone="warn" title={`${me.full_name} may receive stock, but not add products.`}>
            Receiving a delivery is an everyday job and your role can do it. Creating products
            in bulk is a planner or admin job — the refusal comes from the database, not from
            this page.
          </Notice>
        </div>
      )}

      <ImportTabs
        receive={
          data.locations.length === 0 ? (
            <Notice tone="bad" title="You have no location to receive into.">
              Stock belongs to a place. Ask an admin to give you access to a shop or a
              warehouse.
            </Notice>
          ) : (
            <ReceiveForm locations={data.locations} canReceive />
          )
        }
        catalogue={
          <>
            <div className="mb-4">
              <Notice tone="info" title="This creates PRODUCTS, not stock.">
                A row here is a thing the shop sells — its name, unit, category and price. To
                say how many arrived, use “Receive stock”.
              </Notice>
            </div>
            <ImportForm
              kind="products"
              templates={templates}
              categories={data.categories}
              uoms={data.uoms}
              locations={locationCodes}
              canImport={canImport}
            />
          </>
        }
        opening={
          <>
            <div className="mb-4">
              <Notice tone="warn" title="For go-live, not for deliveries.">
                An opening balance says what was already on the shelf on the day this system
                started. Use it once. A delivery that arrives afterwards is a receipt — it
                carries a supplier, a cost and, for perishables, a lot number, and “Receive
                stock” records all three.
              </Notice>
            </div>
            <ImportForm
              kind="stock"
              templates={templates}
              categories={data.categories}
              uoms={data.uoms}
              locations={locationCodes}
              canImport={canImport}
            />
          </>
        }
      />
    </>
  );
}
