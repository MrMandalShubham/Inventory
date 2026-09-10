"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Notice, Pill, TableWrap } from "../ui";
import { findProducts, postBatch, type BatchResult } from "./receive-actions";
import type { Pickable } from "@/lib/receive";

/**
 * Receive a delivery.
 *
 * Three questions, in the order a person answers them: where did it
 * arrive, where did it come from, and what was in it. Everything else
 * about a product was settled when the product was created.
 */

const INITIAL: BatchResult = {
  mode: "preview", rows: [], units: 0, valuePaise: 0, received: 0, failed: 0,
};

type Line = {
  key: string;
  product: Pickable;
  qty: string;
  /** Counting in packs, or in the base unit. */
  packs: boolean;
  cost: string;
  lot: string;
};

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ReceiveForm({
  locations, canReceive,
}: {
  locations: { id: string; code: string; name: string }[];
  canReceive: boolean;
}) {
  const [state, formAction, pending] = useActionState(postBatch, INITIAL);

  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Pickable[]>([]);
  const [searching, setSearching] = useState(false);
  const searchId = useId();

  // A reference generated ONCE per batch and sent with every attempt.
  // post_movement is idempotent on it, so a double-click, a retry
  // after a timeout, or a browser replaying the POST all land the
  // delivery once. Regenerated only when a batch actually commits.
  const [reference, setReference] = useState(() => crypto.randomUUID());

  // ── search ──
  const seq = useRef(0);
  useEffect(() => {
    if (query.trim().length < 2) { setHits([]); return; }

    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await findProducts(query, locationId || null);
        // A slower earlier request must not overwrite a newer answer.
        if (mine === seq.current) setHits(found);
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, 180);

    return () => clearTimeout(t);
  }, [query, locationId]);

  const add = (p: Pickable) => {
    setQuery("");
    setHits([]);
    setLines((cur) =>
      cur.some((l) => l.product.id === p.id)
        ? cur
        : [...cur, {
            key: p.id, product: p, qty: "",
            // Packs by default when the label can be read, because a
            // delivery is counted in packs.
            packs: p.units_per_pack !== null,
            cost: "", lot: "",
          }]);
  };

  const set = (key: string, patch: Partial<Line>) =>
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const remove = (key: string) => setLines((cur) => cur.filter((l) => l.key !== key));

  // What will actually be sent — packs resolved to base units.
  const payload = lines
    .filter((l) => Number(l.qty) > 0)
    .map((l) => ({
      product_id: l.product.id,
      quantity: Number(l.qty),
      packs: l.packs,
      unit_cost: l.cost.trim() === "" ? null : Math.round(Number(l.cost) * 100),
      lot: l.lot.trim() || null,
    }));

  const baseUnits = (l: Line) => {
    const n = Number(l.qty);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return l.packs && l.product.units_per_pack ? Math.round(n * l.product.units_per_pack) : Math.round(n);
  };

  const committed = state.mode === "commit" && state.received > 0 && !state.fatal;
  const canCommit = state.mode === "preview" && !state.fatal && state.received > 0;

  // After a successful commit the batch is spent: clear it, and take a
  // new reference so the NEXT delivery is not deduplicated against the
  // one just posted.
  const startAnother = () => {
    setLines([]);
    setNote("");
    setQuery("");
    setReference(crypto.randomUUID());
  };

  return (
    <>
      <div className="card">
        <div className="card-pad">
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(180px, 240px) 1fr" }}>
            <div>
              <label className="label" htmlFor="loc">Arrived at</label>
              <select id="loc" className="field w-full" value={locationId}
                      onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.code} — {l.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="note">Note</label>
              <input id="note" className="field w-full" value={note} maxLength={300}
                     onChange={(e) => setNote(e.target.value)}
                     placeholder="Sharma Traders — invoice 4471" />
              <div className="meta">
                Who it came from, or wherever it came from. Written onto every line in this
                batch, and it is what the stock history will show a year from now.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── the picker ── */}
      <div className="card mt-3">
        <div className="card-pad">
          <label className="label" htmlFor={searchId}>Add a product</label>
          <input
            id={searchId} className="field w-full" value={query} autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Start typing a name or a SKU — Haldi, Toor Dal, PRD-2026…"
          />
          <div className="meta">
            Only products already in the inventory. Something new has to be created on the
            product screen first — a receiving screen that can invent a product is how a
            catalogue ends up with two of the same thing.
          </div>

          {query.trim().length >= 2 && (
            <div style={{ marginTop: 8, border: "1px solid var(--color-ink-100)",
                          borderRadius: 6, maxHeight: 280, overflowY: "auto" }}>
              {searching && hits.length === 0 && <div className="card-pad meta">Searching…</div>}

              {!searching && hits.length === 0 && (
                <div className="card-pad meta">
                  Nothing matches “{query}”. Check the spelling, or add the product first.
                </div>
              )}

              {hits.map((p) => {
                const already = lines.some((l) => l.product.id === p.id);
                return (
                  <button
                    key={p.id} type="button" onClick={() => add(p)} disabled={already}
                    style={{
                      display: "block", width: "100%", textAlign: "left", padding: "9px 14px",
                      border: "none", borderBottom: "1px solid var(--color-ink-50)",
                      background: "transparent", cursor: already ? "default" : "pointer",
                      opacity: already ? 0.45 : 1,
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {p.name} {already && <span className="meta">— already added</span>}
                    </div>
                    <div className="meta mono">
                      {p.sku_code}
                      {p.pack_size && ` · ${p.pack_size}`}
                      {` · ${p.on_hand.toLocaleString()} ${p.base_uom.toLowerCase()} here`}
                      {p.tracking_mode === "BATCH" && " · batch-tracked"}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── the lines ── */}
      {lines.length > 0 && (
        <div className="card mt-3">
          <div className="card-pad">
            <TableWrap>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num" style={{ width: 210 }}>Quantity</th>
                  <th className="num" style={{ width: 150 }}>Cost / unit</th>
                  <th style={{ width: 150 }}>Lot</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{l.product.name}</div>
                      <div className="meta mono">
                        {l.product.sku_code}
                        {l.product.pack_size && ` · ${l.product.pack_size}`}
                      </div>
                    </td>

                    <td className="num">
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <input
                          className="field tnum" inputMode="decimal" value={l.qty}
                          style={{ width: 90, textAlign: "right" }}
                          onChange={(e) => set(l.key, { qty: e.target.value })}
                          placeholder="0"
                        />
                        {l.product.units_per_pack ? (
                          <select className="field" value={l.packs ? "packs" : "base"}
                                  style={{ width: 96 }}
                                  onChange={(e) => set(l.key, { packs: e.target.value === "packs" })}>
                            <option value="packs">packs</option>
                            <option value="base">{l.product.base_uom.toLowerCase()}</option>
                          </select>
                        ) : (
                          <span className="meta" style={{ alignSelf: "center", width: 96 }}>
                            {l.product.base_uom.toLowerCase()}
                          </span>
                        )}
                      </div>
                      {l.packs && l.product.units_per_pack && Number(l.qty) > 0 && (
                        <div className="meta">
                          = {baseUnits(l).toLocaleString()} {l.product.base_uom.toLowerCase()}
                        </div>
                      )}
                    </td>

                    <td className="num">
                      <input
                        className="field tnum" inputMode="decimal" value={l.cost}
                        style={{ width: 110, textAlign: "right" }}
                        onChange={(e) => set(l.key, { cost: e.target.value })}
                        placeholder={l.product.cost_paise !== null
                          ? (l.product.cost_paise / 100).toFixed(2)
                          : "required"}
                      />
                      <div className="meta">
                        {l.product.cost_paise !== null
                          ? `per ${l.product.base_uom.toLowerCase()}, blank keeps ${rupees(l.product.cost_paise)}`
                          : `per ${l.product.base_uom.toLowerCase()} — never costed here`}
                      </div>
                    </td>

                    <td>
                      {l.product.tracking_mode === "BATCH" ? (
                        <>
                          <input
                            className="field mono" value={l.lot} style={{ width: 130 }}
                            onChange={(e) => set(l.key, { lot: e.target.value })}
                            placeholder={new Date().toISOString().slice(0, 10)}
                          />
                          <div className="meta">
                            {l.product.shelf_life_days
                              ? `expires in ${l.product.shelf_life_days} days`
                              : "code on the pack"}
                          </div>
                        </>
                      ) : (
                        <span className="meta">—</span>
                      )}
                    </td>

                    <td>
                      <button type="button" className="btn-ghost" onClick={() => remove(l.key)}
                              aria-label={`Remove ${l.product.name}`}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>

            <form action={formAction} className="mt-3">
              <input type="hidden" name="mode" value="preview" />
              <input type="hidden" name="location" value={locationId} />
              <input type="hidden" name="note" value={note} />
              <input type="hidden" name="reference" value={reference} />
              <input type="hidden" name="lines" value={JSON.stringify(payload)} />

              <div className="flex items-center gap-3">
                <button type="submit" className="btn" disabled={pending || payload.length === 0}>
                  {pending ? "Checking…" : `Check ${payload.length} line${payload.length === 1 ? "" : "s"}`}
                </button>
                <span className="meta">
                  Nothing is written yet. Every line is posted for real and rolled back, so
                  what you see next is exactly what will happen.
                </span>
              </div>
            </form>
          </div>
        </div>
      )}

      {state.fatal && (
        <div className="mt-4">
          <Notice tone="bad" title="Nothing was received.">{state.fatal}</Notice>
        </div>
      )}

      {state.rows.length > 0 && (
        <div className="mt-4">
          <h2 style={{ marginBottom: 4 }}>
            {committed ? "Received" : "Ready to receive"} — {state.received} line
            {state.received === 1 ? "" : "s"}, {state.units.toLocaleString()} units,{" "}
            {rupees(state.valuePaise)}
            {state.failed > 0 && ` · ${state.failed} rejected`}
          </h2>

          {!committed && (
            <p className="meta">
              Nothing has been written.
              {state.failed > 0 && " The rejected lines below will be skipped; the rest still land."}
            </p>
          )}

          {canCommit && canReceive && (
            <form action={formAction} className="mb-3">
              <input type="hidden" name="mode" value="commit" />
              <input type="hidden" name="location" value={locationId} />
              <input type="hidden" name="note" value={note} />
              <input type="hidden" name="reference" value={reference} />
              <input type="hidden" name="lines" value={JSON.stringify(payload)} />
              <button type="submit" className="btn" disabled={pending}>
                {pending ? "Receiving…" : `Receive ${state.received} line${state.received === 1 ? "" : "s"}`}
              </button>
            </form>
          )}

          {committed && (
            <div className="mb-3">
              <button type="button" className="btn" onClick={startAnother}>
                Receive another delivery
              </button>
            </div>
          )}

          <TableWrap>
            <thead>
              <tr>
                <th className="num w-16">Line</th>
                <th>Status</th>
                <th>Product</th>
                <th className="num">Units</th>
                <th className="num">Value</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((r) => (
                <tr key={r.row}>
                  <td className="num tnum">{r.row}</td>
                  <td>
                    <Pill tone={r.status === "FAILED" ? "bad" : "good"}>
                      {r.status === "FAILED" ? "rejected" : committed ? "received" : "ready"}
                    </Pill>
                  </td>
                  <td>
                    {r.name ?? "—"}
                    <div className="meta mono">{r.sku ?? ""}</div>
                  </td>
                  <td className="num tnum">{r.units?.toLocaleString() ?? "—"}</td>
                  <td className="num tnum">
                    {r.value_paise === null ? "—" : rupees(r.value_paise)}
                  </td>
                  <td className={r.status === "FAILED" ? "text-rose-700" : "text-ink-500"}>
                    {r.detail ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      )}
    </>
  );
}
