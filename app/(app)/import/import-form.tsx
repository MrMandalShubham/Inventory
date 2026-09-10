"use client";

import { useActionState, useRef, useState } from "react";
import { Notice, Pill, TableWrap } from "../ui";
import { runImport, type ImportResult } from "./actions";

/**
 * The import form.
 *
 * A client component because it has to show a result without throwing
 * away what was typed, and because the whole point of the rework is
 * the two-step: look at what will happen, then agree to it.
 */

const INITIAL: ImportResult = {
  kind: "products", mode: "preview", csv: "", ignored: [], rows: [],
  counts: { created: 0, updated: 0, failed: 0, priced: 0 },
};

export type Templates = { products: string; stock: string };

export function ImportForm({
  templates, categories, uoms, locations, canImport,
}: {
  templates: Templates;
  categories: { id: string; name: string }[];
  uoms: string[];
  locations: string[];
  canImport: boolean;
}) {
  const [state, formAction, pending] = useActionState(runImport, INITIAL);
  const [kind, setKind] = useState<"products" | "stock">("products");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A preview worth acting on: it ran, it was a preview, and something
  // would actually land.
  const landed = state.counts.created + state.counts.updated;
  const canCommit =
    state.mode === "preview" && !state.fatal && landed > 0 && state.kind === kind;

  const pick = (k: "products" | "stock") => {
    setKind(k);
    setCsv("");
    setFileName(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {([["products", "Products"], ["stock", "Opening stock"]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => pick(k)} style={{
            padding: "7px 15px", borderRadius: 4, fontSize: 14, fontWeight: 600,
            cursor: "pointer",
            border: `1px solid ${kind === k ? "var(--accent)" : "var(--line)"}`,
            background: kind === k ? "var(--accent)" : "transparent",
            color: kind === k ? "#fff" : "inherit",
          }}>{label}</button>
        ))}
      </div>

      <div className="card">
        <div className="card-pad">
          <p className="meta" style={{ marginTop: 0 }}>
            {kind === "products" ? (
              <>
                One row per product. Only <span className="mono">name</span> is required —
                everything else fills in what it can. Include{" "}
                <span className="mono">retail</span> and <span className="mono">mrp</span>{" "}
                together and the product comes out priced and sellable; include{" "}
                <span className="mono">sku</span> to update one that already exists.
              </>
            ) : (
              <>
                One row per product per location. Identify the product by{" "}
                <span className="mono">sku</span> or by <span className="mono">name</span>,
                and give a <span className="mono">location</span> and a{" "}
                <span className="mono">quantity</span> in base units.{" "}
                <span className="mono">cost</span> is what you paid per unit — without it
                the stock enters the books at no value.
              </>
            )}
          </p>

          <form action={formAction}>
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="mode" value="preview" />

            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12,
                          flexWrap: "wrap" }}>
              <label className="btn" style={{ cursor: "pointer", margin: 0 }}>
                Choose a CSV file
                <input
                  ref={fileRef}
                  type="file"
                  name="file"
                  accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setFileName(f.name);
                    // Shown in the box as well as sent, so nobody has to
                    // guess whether the right file was picked — and so a
                    // small fix can be made without re-exporting it.
                    setCsv(await f.text());
                  }}
                />
              </label>

              {fileName && <span className="meta mono">{fileName}</span>}

              <span className="meta">or paste below</span>

              <button
                type="button"
                className="btn-ghost"
                onClick={() => { setCsv(templates[kind]); setFileName(null); }}
              >
                Load a template
              </button>
            </div>

            <textarea
              id="csv" name="csv" rows={12} spellCheck={false}
              className="field mono w-full resize-y"
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setFileName(null); }}
              placeholder={templates[kind].split("\n").slice(0, 2).join("\n")}
            />

            <div className="mt-3 flex items-center gap-3">
              <button type="submit" className="btn" disabled={pending || !csv.trim()}>
                {pending ? "Checking…" : "Preview"}
              </button>
              <span className="meta">
                Nothing is written yet. The preview runs every row for real and rolls it back.
              </span>
            </div>
          </form>
        </div>
      </div>

      {/* ── valid values, so a typo is a choice rather than a discovery ── */}
      <details className="card mt-3">
        <summary className="card-pad" style={{ cursor: "pointer", fontWeight: 600 }}>
          What the columns accept
        </summary>
        <div className="card-pad" style={{ paddingTop: 0 }}>
          <p className="meta">
            Headers are matched loosely: <span className="mono">Product Name</span>,{" "}
            <span className="mono">MRP (₹)</span> and <span className="mono">Selling Price</span>{" "}
            all land where you would expect. Money may carry ₹ and commas.
          </p>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px",
                       fontSize: 13, margin: 0 }}>
            <dt className="mono">category</dt>
            <dd style={{ margin: 0 }}>
              {categories.map((c) => c.name).join(" · ")}
              <div className="meta">
                Anything else creates a new category — which then appears as an extra tile
                in the storefront.
              </div>
            </dd>

            <dt className="mono">base_uom</dt>
            <dd style={{ margin: 0 }}>{uoms.join(" · ")}</dd>

            <dt className="mono">tracking_mode</dt>
            <dd style={{ margin: 0 }}>
              NONE · BATCH · SERIAL
              <div className="meta">
                BATCH for anything with an expiry. SERIAL means every single unit carries its
                own number — right for appliances, wrong for groceries.
              </div>
            </dd>

            <dt className="mono">location</dt>
            <dd style={{ margin: 0 }}>{locations.join(" · ")}</dd>
          </dl>
        </div>
      </details>

      {state.fatal && (
        <div className="mt-4">
          <Notice tone="bad" title="Nothing was imported.">{state.fatal}</Notice>
        </div>
      )}

      {state.ignored.length > 0 && !state.fatal && (
        <div className="mt-4">
          <Notice tone="warn" title="Columns that were not recognised, and were skipped:">
            <span className="mono">{state.ignored.join(", ")}</span>
            <div className="meta">
              Rename them if they matter — a column nobody reads looks exactly like one that
              worked.
            </div>
          </Notice>
        </div>
      )}

      {state.rows.length > 0 && (
        <div className="mt-4">
          <h2 style={{ marginBottom: 4 }}>
            {state.mode === "preview" ? "Preview" : "Imported"}
            {" — "}
            {state.counts.created} new
            {state.counts.updated > 0 && `, ${state.counts.updated} updated`}
            {state.counts.priced > 0 && `, ${state.counts.priced} priced`}
            {state.counts.failed > 0 && `, ${state.counts.failed} rejected`}
          </h2>

          {state.mode === "preview" ? (
            <p className="meta">
              Nothing has been written. {state.counts.failed > 0 && (
                <>The {state.counts.failed} rejected row
                {state.counts.failed === 1 ? "" : "s"} below will be skipped — the rest still
                land. </>
              )}
            </p>
          ) : (
            <p className="meta">Written. {state.counts.failed > 0 &&
              `${state.counts.failed} row(s) were skipped and are listed below.`}</p>
          )}

          {canCommit && canImport && (
            <form action={formAction} className="mb-3">
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="mode" value="commit" />
              <input type="hidden" name="csv" value={state.csv} />
              <button type="submit" className="btn" disabled={pending}>
                {pending ? "Importing…" : `Import ${landed} row${landed === 1 ? "" : "s"}`}
              </button>
            </form>
          )}

          <TableWrap>
            <thead>
                <tr>
                  <th className="num w-16">Row</th>
                  <th>Status</th>
                  <th>{kind === "products" ? "SKU" : "Product"}</th>
                  <th>{kind === "products" ? "Price" : "Location"}</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r, i) => (
                  <tr key={`${r.row}-${i}`}>
                    <td className="num tnum">{r.row}</td>
                    <td>
                      <Pill tone={r.status === "FAILED" ? "bad"
                        : r.status === "UPDATED" ? "info" : "good"}>
                        {r.status.toLowerCase()}
                      </Pill>
                    </td>
                    <td className="mono">{r.code ?? "—"}</td>
                    <td className="meta">{r.extra ?? "—"}</td>
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
