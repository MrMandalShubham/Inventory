/** Parse a CSV body into the row objects import_products expects.
 *
 * Lives here rather than in actions.ts because a "use server" module
 * may only export async functions — everything in it becomes a
 * callable server action, and a sync helper is not one.
 */
export type ImportRow = {
  row_number: number;
  sku_code: string | null;
  status: string;
  message: string | null;
};

export function parseCsv(text: string): Record<string, unknown>[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const split = (line: string) => {
    // Minimal CSV: handles quoted fields containing commas.
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      const v = cells[i] ?? "";
      if (v === "") return;
      if (h === "shelf_life_days" || h === "tax_rate") obj[h] = Number(v);
      else if (h === "is_weighed") obj[h] = /^(true|yes|y|1)$/i.test(v);
      else obj[h] = v;
    });
    return obj;
  });
}
