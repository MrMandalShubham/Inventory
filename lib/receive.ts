import type { PoolClient } from "pg";
import { unitsPerPack } from "./pack";

/**
 * Receiving a batch of stock.
 *
 * ── What this is, and what it is not ──
 *
 * It is not a catalogue import. A product's category, unit, HSN code,
 * shelf life and tax rate were all decided when the product was
 * created, and asking for them again every time a delivery arrives is
 * how a twelve-column spreadsheet became the price of adding four
 * cartons of turmeric.
 *
 * So a line here is a product that ALREADY EXISTS, a quantity, and
 * nothing else. The note belongs to the batch, not the line: it says
 * where the delivery came from.
 *
 * ── Why RECEIPT rather than an opening balance ──
 *
 * OPENING is the day-one position, loaded once at go-live. Using it
 * for every delivery would say the shop opened for business again this
 * morning, and it bypasses the batch requirement — which is exactly
 * the check that stops perishables arriving without a lot number.
 *
 * RECEIPT means "arrived from outside the business", needs no
 * approval, and an operator may post it. That is what a delivery is.
 */

export type ReceiveLine = {
  product_id: string;
  /** In whatever unit the operator chose; `packs` says which. */
  quantity: number;
  /** true = quantity is in packs, false = already in base units. */
  packs?: boolean;
  /** Paise per BASE unit. Omitted means "value it at what it is worth now". */
  unit_cost?: number | null;
  /** Only for batch-tracked products. */
  lot?: string | null;
  expiry?: string | null;
};

export type ReceiveResult = {
  row: number;
  status: "RECEIVED" | "FAILED";
  sku: string | null;
  name: string | null;
  detail: string | null;
  /** What actually went onto the shelf, in base units. */
  units: number | null;
  value_paise: number | null;
};

/** What the picker needs to show one product. */
export type Pickable = {
  id: string;
  sku_code: string;
  name: string;
  pack_size: string | null;
  base_uom: string;
  tracking_mode: string;
  shelf_life_days: number | null;
  units_per_pack: number | null;
  /** Weighted average cost at this location, in paise per base unit. */
  cost_paise: number | null;
  on_hand: number;
};

/**
 * Products the operator can receive, matching what they typed.
 *
 * Only products that already exist, deliberately. A receiving screen
 * that can invent a product is a receiving screen that creates
 * "Haldi Powder" for the second time because somebody typed it
 * slightly differently — which is how the live catalogue ended up with
 * two of them.
 */
export async function searchProducts(
  c: PoolClient, query: string, locationId: string | null, limit = 20,
): Promise<Pickable[]> {
  const q = query.trim();

  const { rows } = await c.query(`
    select p.id, p.sku_code, p.name, p.pack_size, p.tracking_mode, p.shelf_life_days,
           u.code as base_uom,
           b.weighted_avg_cost as cost_paise,
           coalesce(b.on_hand, 0) as on_hand
      from catalog.product p
      join catalog.uom u on u.id = p.base_uom_id
      left join stock.balance b
             on b.product_id = p.id and b.batch_id is null
            and ($2::uuid is null or b.location_id = $2)
     where p.status = 'ACTIVE'
       and ($1 = '' or p.name ilike '%' || $1 || '%' or p.sku_code ilike '%' || $1 || '%')
     order by (p.name ilike $1 || '%') desc, p.name
     limit $3`, [q, locationId, limit]);

  return rows.map((r: any) => ({
    id: r.id,
    sku_code: r.sku_code,
    name: r.name,
    pack_size: r.pack_size,
    base_uom: r.base_uom,
    tracking_mode: r.tracking_mode,
    shelf_life_days: r.shelf_life_days,
    units_per_pack: unitsPerPack(r.pack_size, r.base_uom),
    cost_paise: r.cost_paise === null ? null : Number(r.cost_paise),
    on_hand: Number(r.on_hand),
  }));
}

/**
 * A lot number for a delivery that did not come with one.
 *
 * Perishables must carry a lot or a recall has nothing to act on. Most
 * deliveries into a small shop have no printed lot code, so refusing
 * the line would mean nobody could receive milk. The receipt date is a
 * real, checkable answer to "which delivery was this" — and the
 * operator can overwrite it with the code on the carton when there is
 * one.
 */
function defaultLot(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function receiveBatch(
  c: PoolClient,
  input: {
    locationId: string;
    note: string | null;
    lines: ReceiveLine[];
    /** Stable across retries, so a double-submit posts once. */
    reference?: string | null;
  },
): Promise<{ rows: ReceiveResult[]; units: number; valuePaise: number }> {
  const out: ReceiveResult[] = [];
  let units = 0;
  let valuePaise = 0;

  for (const [i, line] of input.lines.entries()) {
    const row = i + 1;

    const { rows: [p] } = await c.query(`
      select p.id, p.sku_code, p.name, p.pack_size, p.tracking_mode, p.shelf_life_days,
             u.code as base_uom,
             (select b.weighted_avg_cost from stock.balance b
               where b.product_id = p.id and b.location_id = $2 and b.batch_id is null) as wac
        from catalog.product p
        join catalog.uom u on u.id = p.base_uom_id
       where p.id = $1 and p.status = 'ACTIVE'`, [line.product_id, input.locationId]);

    if (!p) {
      out.push({ row, status: "FAILED", sku: null, name: null,
        detail: "that product no longer exists", units: null, value_paise: null });
      continue;
    }

    // ── one savepoint per line ──
    //
    // Without it the first bad line takes every line after it. A SQL
    // error aborts the whole transaction in Postgres, so the catch
    // below would run, the loop would continue, and every remaining
    // statement would fail with "current transaction is aborted" —
    // reported as a hundred broken rows when one was.
    //
    // This is the same shape import_products uses in plpgsql, for the
    // same reason: a bad row is that row's problem.
    await c.query(`savepoint line_${row}`);

    try {
      const per = unitsPerPack(p.pack_size, p.base_uom);
      const qty = line.packs && per ? Math.round(line.quantity * per) : Math.round(line.quantity);

      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("quantity must be a positive number");
      }

      // ── what it is worth ──
      //
      // An explicit cost wins. Without one the goods are valued at
      // what this location already values them at, which keeps the
      // weighted average where it is rather than dragging it to zero.
      //
      // With neither, the line is refused. Stock entering at no value
      // reports the whole delivery as worthless and quietly wrecks the
      // valuation — migration 0032 exists because of exactly that.
      const cost = line.unit_cost ?? (p.wac === null ? null : Number(p.wac));

      if (cost === null || cost <= 0) {
        throw new Error(
          "this product has never been costed here, so the first receipt must say " +
          "what it cost per unit");
      }

      // ── the lot, for anything perishable ──
      let batchId: string | null = null;

      if (p.tracking_mode === "BATCH") {
        const lot = (line.lot ?? "").trim() || defaultLot(new Date());

        const expiry = line.expiry ??
          (p.shelf_life_days
            ? new Date(Date.now() + p.shelf_life_days * 86400000).toISOString().slice(0, 10)
            : null);

        // The same lot arriving twice is the same lot — two rows for
        // it would split a recall in half.
        const { rows: [b] } = await c.query(`
          insert into stock.batch (product_id, lot_no, expiry_date)
               values ($1, $2, $3::date)
          on conflict (product_id, lot_no) do update set lot_no = excluded.lot_no
            returning id`, [p.id, lot, expiry]);

        batchId = b.id;
      }

      const key = input.reference ? `${input.reference}:${row}` : null;

      await c.query(
        "select stock.post_movement($1,$2,$3,'RECEIPT',$4,$5,null,$6,now(),$7)",
        [p.id, input.locationId, qty, batchId, input.note, cost, key]);

      units += qty;
      valuePaise += qty * cost;

      await c.query(`release savepoint line_${row}`);

      out.push({ row, status: "RECEIVED", sku: p.sku_code, name: p.name,
        detail: null, units: qty, value_paise: qty * cost });
    } catch (e) {
      await c.query(`rollback to savepoint line_${row}`).catch(() => {});

      const msg = e instanceof Error ? e.message : String(e);
      out.push({ row, status: "FAILED", sku: p.sku_code, name: p.name,
        detail: msg.replace(/^[A-Z_]+:\s*/, ""), units: null, value_paise: null });
    }
  }

  return { rows: out, units, valuePaise };
}
