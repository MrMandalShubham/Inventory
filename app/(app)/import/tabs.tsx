"use client";

import { useState, type ReactNode } from "react";

/**
 * Receiving stock and loading a catalogue are different jobs.
 *
 * They shared one screen because both start with "import", and the
 * result was a twelve-column CSV standing between a shopkeeper and
 * four cartons of turmeric. Receiving is the thing that happens every
 * week, so it is first and it is the default.
 */
export function ImportTabs({
  receive, catalogue, opening,
}: {
  receive: ReactNode;
  catalogue: ReactNode;
  opening: ReactNode;
}) {
  const [tab, setTab] = useState<"receive" | "catalogue" | "opening">("receive");

  // Flat, not nested. The catalogue pane used to carry its own tab
  // strip, which would have put tabs inside tabs the moment receiving
  // got one of its own.
  const TABS = [
    ["receive", "Receive stock", "A delivery arrived"],
    ["catalogue", "Add products in bulk", "A spreadsheet of new products"],
    ["opening", "Opening balances", "What was on the shelf at go-live"],
  ] as const;

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {TABS.map(([k, label, hint]) => (
          <button key={k} type="button" onClick={() => setTab(k)} style={{
            padding: "9px 16px", borderRadius: 6, fontSize: 14, cursor: "pointer",
            textAlign: "left",
            border: `1px solid ${tab === k ? "var(--color-teal-600)" : "var(--color-ink-100)"}`,
            background: tab === k ? "var(--color-teal-600)" : "transparent",
            color: tab === k ? "#fff" : "inherit",
          }}>
            <div style={{ fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{hint}</div>
          </button>
        ))}
      </div>

      {/* Both stay mounted so switching tabs does not discard a
          half-built delivery or a pasted file. */}
      <div hidden={tab !== "receive"}>{receive}</div>
      <div hidden={tab !== "catalogue"}>{catalogue}</div>
      <div hidden={tab !== "opening"}>{opening}</div>
    </>
  );
}
