import Link from "next/link";
import { withSession } from "@/lib/db";
import { currentClaims, currentSession } from "@/lib/session";
import { createProduct } from "../../actions";
import { ImagePicker } from "./image-picker";

export const dynamic = "force-dynamic";

export default async function NewProduct({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const claims = await currentClaims();
  const me = await currentSession();

  const uoms = await withSession(claims, async (c) => {
    const { rows } = await c.query(
      "select code, name, kind, is_base from catalog.uom order by is_base desc, kind, code",
    );
    return rows;
  });

  const canWrite = me && ["planner", "admin"].includes(me.role);

  return (
    <>
      <h1>Add product</h1>
      <p className="lede">
        The code is minted automatically and is gapless — you never type one.
        This form calls the same <span className="mono">import_products</span> function the
        CSV screen uses, so a spreadsheet and a form can never disagree about what is valid.
      </p>

      {!canWrite && (
        <div className="notice notice-bad" style={{ marginBottom: 18 }}>
          <b>{me?.full_name}</b> is a {me?.role.replace("_", " ")} and cannot create products.
          Switch to a planner or admin in the header. The database will refuse this write
          regardless of what the form allows — try it.
        </div>
      )}

      {error && <div className="notice notice-bad" style={{ marginBottom: 18 }}><b>Refused:</b> {error}</div>}

      <div className="card">
        <form action={createProduct} className="card-pad">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
            <div>
              <label className="label" htmlFor="name">Name *</label>
              <input className="field" id="name" name="name" required placeholder="Toor Dal 1kg"/>
            </div>

            <div>
              <label className="label" htmlFor="category">Category</label>
              <input className="field" id="category" name="category" placeholder="Staples"/>
            </div>

            <div>
              <label className="label" htmlFor="base_uom">Base unit — always the smallest *</label>
              <select className="field" id="base_uom" name="base_uom" defaultValue="PCS">
                {uoms.map((u: any) => (
                  <option key={u.code} value={u.code}>
                    {u.code} — {u.name}{u.is_base ? " (base)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="tracking_mode">Tracking</label>
              <select className="field" id="tracking_mode" name="tracking_mode" defaultValue="NONE">
                <option value="NONE">Quantity only</option>
                <option value="BATCH">Batch and expiry</option>
                <option value="SERIAL">Every individual unit</option>
              </select>
            </div>

            <div>
              <label className="label" htmlFor="shelf_life_days">Shelf life (days)</label>
              <input className="field" id="shelf_life_days" name="shelf_life_days" type="number" min="1" placeholder="leave blank if it does not expire"/>
            </div>

            <div>
              <label className="label" htmlFor="hsn_code">HSN code</label>
              <input className="field" id="hsn_code" name="hsn_code" placeholder="1006"/>
            </div>

            <div>
              <label className="label" htmlFor="barcode">Barcode</label>
              <input className="field" id="barcode" name="barcode" placeholder="8901234567890"/>
            </div>

            <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
                <input type="checkbox" name="is_weighed" style={{ width: "auto" }} />
                Sold by weight
              </label>
            </div>
          </div>

          <div style={{ marginTop: 22 }}>
            <label className="label" htmlFor="image_file">Photograph</label>
            <ImagePicker />
          </div>

          <div className="notice notice-info" style={{ margin: "18px 0" }}>
            <b>Quantities are stored as whole numbers in the smallest unit.</b> A product based
            in <span className="mono">G</span> holds grams, not fractional kilos — the same
            reason money is held in paise. A product with a shelf life must be batch or serial
            tracked, or the expiry has nowhere to live; the database enforces that.
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" className="btn">Create product</button>
            <Link href="/products" style={{
              padding: "8px 16px", border: "1px solid var(--rule)", borderRadius: 4,
              textDecoration: "none", color: "var(--accent)", fontWeight: 600, fontSize: 15,
            }}>Cancel</Link>
          </div>
        </form>
      </div>
    </>
  );
}
