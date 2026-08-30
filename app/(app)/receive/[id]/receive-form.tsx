"use client";

import { useCallback, useRef, useState } from "react";
import { Scanner } from "../scanner";

export type Line = {
  id: string;
  sku_code: string;
  name: string;
  uom: string;
  lot_no: string | null;
  barcode: string | null;
  expected: number;
};

/**
 * The receiving flow.
 *
 * ── The gate ──
 *
 *   An operator receives a shipment end to end on a phone using only
 *   the scanner, typing nothing except a variance reason.
 *
 * So scanning does the work. A scan finds the line, confirms the full
 * expected quantity and marks it done — one action per carton, no
 * typing. The number only gets touched when the count disagrees with
 * the note, which is the exception rather than the rule.
 *
 * Everything else follows from that: the scanned line jumps to the
 * top, the count is pre-filled, and reporting a problem is one tap
 * away rather than a field on every row. Making all 40 lines carry a
 * reject box slows down the 39 that are fine.
 */
export function ReceiveForm({
  lines, action, ticketNo, movementId, back, canCost = false, isTransfer = false,
}: {
  lines: Line[];
  action: (fd: FormData) => void;
  ticketNo: string;
  movementId: string;
  back: string;
  /** Whether this person may state what the delivery cost to get here. */
  canCost?: boolean;
  /** Our own stock arriving from our own shop. It already has a cost. */
  isTransfer?: boolean;
}) {
  const [counted, setCounted] = useState<Record<string, number>>({});
  const [problem, setProblem] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<{ id: string; text: string; bad?: boolean } | null>(null);
  const [order, setOrder] = useState<string[]>(lines.map((l) => l.id));
  const formRef = useRef<HTMLFormElement>(null);

  const done = Object.keys(counted).length;
  const remaining = lines.length - done;

  const handleScan = useCallback((code: string) => {
    const clean = code.trim();
    const line =
      lines.find((l) => l.barcode === clean) ??
      lines.find((l) => l.sku_code.toLowerCase() === clean.toLowerCase());

    if (!line) {
      setFlash({ id: "", text: `${clean} is not on this delivery note`, bad: true });
      return;
    }

    // A scan means "all of it arrived". That is the common case and
    // it is the one that has to cost a single action.
    setCounted((c) => ({ ...c, [line.id]: line.expected }));
    setOrder((o) => [line.id, ...o.filter((x) => x !== line.id)]);
    setFlash({ id: line.id, text: `${line.name} — ${line.expected} ${line.uom} confirmed` });
  }, [lines]);

  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  const ordered = order.map((id) => byId[id]).filter(Boolean);

  return (
    <div className="space-y-4">
      <Scanner
        onScan={handleScan}
        hint="A scan confirms the whole quantity on the note. Adjust only when the count disagrees."
      />

      {flash && (
        <div className={`notice ${flash.bad ? "notice-bad" : "notice-info"}`} role="status">
          {flash.bad ? "✕ " : "✓ "}{flash.text}
        </div>
      )}

      <div className="flex items-center gap-3 rounded-lg bg-white px-4 py-3 border border-ink-100">
        <div className="flex-1">
          <div className="h-sect">{done} of {lines.length} counted</div>
          <div className="meta">{remaining === 0 ? "Ready to confirm" : `${remaining} to go`}</div>
        </div>
        <div className="h-2 w-28 overflow-hidden rounded-full bg-ink-100">
          <div className="h-full bg-teal-600 transition-[width] duration-200"
               style={{ width: `${(done / Math.max(lines.length, 1)) * 100}%` }} />
        </div>
      </div>

      <form ref={formRef} action={action} className="space-y-3">
        {/* Inside the form, not beside it — a hidden input outside the
            form element is not submitted with it. */}
        <input type="hidden" name="id" value={movementId} />
        <input type="hidden" name="back" value={back} />

        {ordered.map((l, i) => {
          const value = counted[l.id];
          const isDone = value !== undefined;
          const short = isDone && value !== l.expected;

          return (
            <div key={l.id}
                 className={`card overflow-hidden transition-colors ${
                   isDone ? (short ? "border-amber-500" : "border-moss-600") : ""}`}>
              <div className={`flex items-start gap-3 px-4 py-3 ${
                isDone ? (short ? "bg-amber-50" : "bg-moss-100/50") : "bg-ink-50"}`}>
                <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                  isDone ? "bg-teal-600 text-white" : "bg-ink-200 text-ink-700"}`}>
                  {isDone ? "✓" : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold leading-tight">{l.name}</div>
                  <div className="mono text-ink-400">
                    {l.sku_code}
                    {l.barcode && <> · {l.barcode}</>}
                    {l.lot_no && <> · lot {l.lot_no}</>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-2xl font-bold leading-none tnum">{l.expected}</div>
                  <div className="meta">on the note</div>
                </div>
              </div>

              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="label m-0 min-w-20" htmlFor={`recv_${l.id}`}>Counted</label>
                  <input
                    id={`recv_${l.id}`}
                    name={`recv_${l.id}`}
                    type="number" min="0" required inputMode="numeric"
                    value={value ?? ""}
                    onChange={(e) =>
                      setCounted((c) => ({ ...c, [l.id]: Number(e.target.value) }))}
                    className="field w-28 text-right text-xl font-bold tnum"
                  />
                  <span className="meta">{l.uom}</span>

                  {!isDone && (
                    <button type="button"
                            onClick={() => {
                              setCounted((c) => ({ ...c, [l.id]: l.expected }));
                              setFlash({ id: l.id, text: `${l.name} — ${l.expected} ${l.uom} confirmed` });
                            }}
                            className="btn btn-ghost ml-auto text-[13px] py-1.5">
                      All arrived
                    </button>
                  )}
                  {short && <span className="pill pill-warn ml-auto">differs from the note</span>}
                </div>

                <button type="button"
                        onClick={() => setProblem((p) => ({ ...p, [l.id]: !p[l.id] }))}
                        className="mt-3 text-sm font-semibold text-amber-700 hover:underline">
                  {problem[l.id] ? "Never mind" : "Something is wrong with this line"}
                </button>

                {problem[l.id] && (
                  <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="w-32">
                        <label className="label" htmlFor={`rej_${l.id}`}>Unusable</label>
                        <input id={`rej_${l.id}`} name={`rej_${l.id}`} type="number" min="0"
                               inputMode="numeric" defaultValue={0}
                               className="field text-right text-lg font-bold tnum" />
                      </div>
                      <div className="min-w-48 flex-1">
                        <label className="label" htmlFor={`why_${l.id}`}>What is wrong</label>
                        <input id={`why_${l.id}`} name={`why_${l.id}`} className="field"
                               placeholder="crushed in transit" />
                      </div>
                    </div>
                    <p className="meta mt-2">
                      Every rejected unit needs a reason. &ldquo;3 rejected&rdquo; on its own
                      is a number nobody can dispute with the carrier.
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {canCost && !isTransfer && (
          <details className="card card-pad">
            <summary className="cursor-pointer text-sm font-semibold">
              Delivery charges on this consignment
              <span className="meta ml-2 font-normal">optional — last chance</span>
            </summary>

            <p className="meta mt-2">
              Freight and handling belong to the goods, not to a separate bill. Entered
              here they are spread across the lines by value, and the stock is worth
              that much from this moment on. <b>This cannot be changed afterwards</b> —
              once the count is confirmed the cost is fixed and has already reached the
              accounts.
            </p>

            <div className="mt-3 flex flex-wrap gap-3">
              <div className="min-w-40 flex-1">
                <label className="label" htmlFor="freight">Freight ₹</label>
                <input id="freight" name="freight" type="number" min="0" step="0.01"
                       inputMode="decimal" placeholder="500.00"
                       className="field text-right tnum" />
              </div>
              <div className="min-w-40 flex-1">
                <label className="label" htmlFor="other_charges">Other charges ₹</label>
                <input id="other_charges" name="other_charges" type="number" min="0"
                       step="0.01" inputMode="decimal" placeholder="0.00"
                       className="field text-right tnum" />
              </div>
            </div>
          </details>
        )}

        <div className="sticky bottom-0 -mx-4 bg-ink-50/95 px-4 py-4 backdrop-blur md:mx-0 md:px-0">
          <button type="submit" className="btn btn-lg w-full" disabled={done < lines.length}>
            {done < lines.length
              ? `${remaining} line(s) still to count`
              : `Confirm receipt of ${ticketNo}`}
          </button>
          <p className="meta mt-2 text-center">
            If everything matches, the ticket closes itself. If it does not, it stops for a
            manager — not for you.
          </p>
        </div>
      </form>
    </div>
  );
}
