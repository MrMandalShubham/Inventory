/**
 * How many base units are in one pack.
 *
 * ── Why this exists ──
 *
 * Stock is counted in the base unit — grams, millilitres, pieces —
 * because that is the only unit a ledger can add up across pack sizes.
 * Nobody buys or receives in those units. A delivery is "ten cartons
 * of Haldi 200g", and typing 10 into a box that means grams puts two
 * hundredths of a packet on the shelf.
 *
 * pack_size is the label a customer reads: "200 g", "1 L", "6 pcs".
 * This turns that string into a multiplier, so a screen can accept the
 * number a person actually has and store the number the ledger needs.
 *
 * Returns null when the label cannot be read with confidence. That is
 * deliberate: a wrong multiplier is worse than no multiplier, because
 * it is silently off by a factor of a thousand rather than visibly
 * absent. The caller falls back to base units and says so.
 */

const FACTOR: Record<string, Record<string, number>> = {
  // base unit → { label unit → how many base units it is }
  G:   { g: 1, gm: 1, gms: 1, gram: 1, grams: 1, kg: 1000, kgs: 1000, kilo: 1000, kilogram: 1000 },
  KG:  { kg: 1, kgs: 1, kilo: 1, kilogram: 1, g: 0.001, gm: 0.001, gram: 0.001 },
  ML:  { ml: 1, mls: 1, millilitre: 1, milliliter: 1, l: 1000, ltr: 1000, litre: 1000, liter: 1000 },
  L:   { l: 1, ltr: 1, litre: 1, liter: 1, ml: 0.001 },
  PCS: { pc: 1, pcs: 1, piece: 1, pieces: 1, no: 1, nos: 1, unit: 1, units: 1 },
  DOZ: { doz: 1, dozen: 1, pc: 1 / 12, pcs: 1 / 12 },
};

/** Units that count things rather than measure them. */
const COUNTING = new Set(["pc", "pcs", "piece", "pieces", "no", "nos", "unit", "units", "pack", "packs"]);

export function unitsPerPack(packSize: string | null, baseUom: string | null): number | null {
  if (!packSize || !baseUom) return null;

  const base = baseUom.toUpperCase();

  // "200 g", "1L", "6 pcs", "1 x 500 ml"
  const m = /([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)\s*$/.exec(packSize.trim());
  if (!m) return null;

  const qty = Number(m[1]);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const unit = m[2].toLowerCase();

  // "6 pcs" against a PCS base is six pieces. "6 pcs" against a GRAM
  // base is six of something whose weight this label does not state —
  // unknowable, so say so rather than assume six grams.
  if (unit === "" || COUNTING.has(unit)) {
    return base === "PCS" || base === "DOZ" || unit === "" ? qty : null;
  }

  const factor = FACTOR[base]?.[unit];
  if (factor === undefined) return null;

  const per = qty * factor;
  // A pack that is a fraction of a base unit cannot be counted in
  // whole base units, and the ledger holds integers.
  return Number.isInteger(per) && per > 0 ? per : null;
}

/** "10 packs (2,000 g)" — what the operator typed, and what will be stored. */
export function describeQuantity(
  packs: number, per: number | null, baseUom: string,
): string {
  if (!per) return `${packs.toLocaleString()} ${baseUom.toLowerCase()}`;
  return `${packs.toLocaleString()} × ${per.toLocaleString()} = ` +
         `${(packs * per).toLocaleString()} ${baseUom.toLowerCase()}`;
}
