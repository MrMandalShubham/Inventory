/**
 * A query-string value, or null if the user did not choose anything.
 *
 * ── Why this exists ──
 *
 * A stock page reported an empty warehouse. Every tile read 0, every
 * row was gone, and the ledger underneath held eight and a half
 * million units.
 *
 * The location filter offers `<option value="">All I can see</option>`.
 * Choosing it and pressing Filter submits `loc=`, so the page received
 * the empty STRING, not undefined. The page then wrote:
 *
 *     [loc ?? null]
 *
 * and `??` only replaces null and undefined. An empty string is
 * neither, so it went to the database intact and the guard
 *
 *     ($1::text is null or l.code = $1)
 *
 * became `l.code = ''` — which matches no location that has ever
 * existed. "Show me everything" was compiled into "show me nothing",
 * and the page said so with total confidence: no error, no empty-state
 * explanation, just zeroes.
 *
 * `||` would have worked here, and that is exactly the trap: `??` is
 * the safer operator almost everywhere else, and reaching for it is
 * usually right. It is wrong on form input, where "the user left it
 * blank" arrives as "" rather than as nothing at all.
 *
 * So the conversion gets a name, and every page that filters a query
 * by something a form submitted uses it.
 */
export function param(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/** The same, for a checkbox or a flag: present and not "false"/"0"/"". */
export function flag(v: string | undefined | null): boolean {
  const s = param(v);
  return s !== null && !/^(false|0|no|off)$/i.test(s);
}

/** A positive integer from a query string, or the fallback. */
export function count(v: string | undefined | null, fallback: number, max = 1000): number {
  const s = param(v);
  if (s === null) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}
