import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { createMovement } from "../actions";

export const dynamic = "force-dynamic";

export default async function NewMovement({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; type?: string }>;
}) {
  const { error, type } = await searchParams;
  const claims = await currentClaims();
  const kind = (type ?? "TRANSFER").toUpperCase();

  const data = await withSession(claims, async (c) => ({
    locations: (await c.query(
      `select id, code, name from platform.location
        where status='ACTIVE' and type <> 'VIRTUAL' order by code`)).rows,
    partners: (await c.query(
      "select id, code, name, kinds from partner.partner where status='ACTIVE' order by name")).rows,
    products: (await c.query(
      `select id, sku_code, name from catalog.product
        where status='ACTIVE' order by sku_code limit 200`)).rows,
  }));

  const isTransfer = kind === "TRANSFER";
  const isImport = kind === "IMPORT";

  return (
    <>
      <h1>Raise a movement</h1>
      <p className="lede">
        Pick what kind it is first — the three have genuinely different shapes, and getting
        that wrong is how an internal transfer accidentally becomes a sale.
      </p>

      <div className="card">
        <div className="card-pad" style={{ display: "flex", gap: 8 }}>
          {["TRANSFER", "IMPORT", "EXPORT"].map((k) => (
            <Link key={k} href={`/movements/new?type=${k}`} style={{
              padding: "7px 15px", borderRadius: 4, textDecoration: "none", fontSize: 14,
              fontWeight: 600,
              background: kind === k ? "var(--accent)" : "transparent",
              color: kind === k ? "#fff" : "var(--accent)",
              border: `1px solid ${kind === k ? "var(--accent)" : "var(--rule)"}`,
            }}>{k.toLowerCase()}</Link>
          ))}
        </div>
      </div>

      <div className="notice notice-info" style={{ marginTop: 16 }}>
        {isTransfer ? (
          <><b>Transfer — between two of your own locations.</b> Produces a delivery challan:
            no tax, no revenue, no profit. You cannot sell to yourself. The goods keep their
            value and only change place.</>
        ) : isImport ? (
          <><b>Import — goods arrive from outside.</b> A supplier delivery or a market
            purchase. There is nothing to dispatch: it arrives, and you receive it.</>
        ) : (
          <><b>Export — goods leave the business.</b> Produces a tax invoice. The ticket ends
            when the goods leave; the customer receives them, not you.</>
        )}
      </div>

      {error && <div className="notice notice-bad" style={{ marginBottom: 18 }}><b>Refused:</b> {error}</div>}

      <div className="card">
        <form action={createMovement} className="card-pad">
          <input type="hidden" name="type" value={kind} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 16 }}>
            {!isImport && (
              <div>
                <label className="label" htmlFor="source">From (our location) *</label>
                <select className="field" id="source" name="source" required>
                  {data.locations.map((l: any) => (
                    <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
                  ))}
                </select>
              </div>
            )}

            {kind !== "EXPORT" && (
              <div>
                <label className="label" htmlFor="dest">To (our location) *</label>
                <select className="field" id="dest" name="dest" required>
                  {data.locations.map((l: any) => (
                    <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
                  ))}
                </select>
              </div>
            )}

            {!isTransfer && (
              <div>
                <label className="label" htmlFor="partner">{isImport ? "Supplier" : "Customer"} *</label>
                <select className="field" id="partner" name="partner" required>
                  {data.partners
                    .filter((p: any) => p.kinds.includes(isImport ? "SUPPLIER" : "CUSTOMER"))
                    .map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              </div>
            )}

            <div>
              <label className="label" htmlFor="product_id">Product *</label>
              <select className="field" id="product_id" name="product_id" required>
                {data.products.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.sku_code} — {p.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="qty">Quantity *</label>
              <input className="field" id="qty" name="qty" type="number" min="1" required placeholder="100"/>
            </div>

            {!isTransfer && (
              <div>
                <label className="label" htmlFor="unit_cost">Unit price (paise)</label>
                <input className="field" id="unit_cost" name="unit_cost" type="number" min="0" placeholder="4200"/>
              </div>
            )}

            <div style={{ gridColumn: "1 / -1" }}>
              <label className="label" htmlFor="note">Note</label>
              <input className="field" id="note" name="note" placeholder="weekly replenishment"/>
            </div>
          </div>

          <div className="notice notice-info" style={{ margin: "18px 0" }}>
            One product per ticket in the working UI. The underlying function already takes
            any number of lines — a proper multi-line picker is Phase 5.
            <br />
            <b>You will not be able to approve this yourself.</b> Separation of duties is
            enforced by the database, not by this form.
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="btn">Raise ticket</button>
            <Link href="/movements" style={{
              padding: "8px 16px", border: "1px solid var(--rule)", borderRadius: 4,
              textDecoration: "none", color: "var(--accent)", fontWeight: 600, fontSize: 15,
            }}>Cancel</Link>
          </div>
        </form>
      </div>
    </>
  );
}
