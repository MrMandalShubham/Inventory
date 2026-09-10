"use server";

import { revalidatePath } from "next/cache";
import { withSession, withRollback } from "@/lib/db";
import { currentClaims } from "@/lib/session";
import { searchProducts, receiveBatch, type Pickable, type ReceiveResult }
  from "@/lib/receive";

/**
 * Receiving a delivery.
 *
 * Two actions: find a product, and post the batch. Everything a
 * product IS was decided when it was created — this screen only ever
 * asks how much arrived.
 */

export async function findProducts(
  query: string, locationId: string | null,
): Promise<Pickable[]> {
  const claims = await currentClaims();
  // A read, but through withSession like everything else: the search
  // must not show a shop's stock to somebody who cannot see that shop.
  return withSession(claims, (c) => searchProducts(c, query, locationId, 20));
}

export type BatchResult = {
  mode: "preview" | "commit";
  fatal?: string;
  rows: ReceiveResult[];
  units: number;
  valuePaise: number;
  received: number;
  failed: number;
};

export async function postBatch(_prev: unknown, form: FormData): Promise<BatchResult> {
  const mode = form.get("mode") === "commit" ? "commit" as const : "preview" as const;
  const locationId = String(form.get("location") ?? "");
  const note = String(form.get("note") ?? "").trim() || null;
  const reference = String(form.get("reference") ?? "").trim() || null;

  const empty: BatchResult = {
    mode, rows: [], units: 0, valuePaise: 0, received: 0, failed: 0,
  };

  if (!locationId) {
    return { ...empty, fatal: "Choose where the delivery arrived." };
  }

  let lines;
  try {
    lines = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch {
    return { ...empty, fatal: "The lines could not be read. Reload and try again." };
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return { ...empty, fatal: "Add at least one product." };
  }

  const claims = await currentClaims();
  const run = (c: any) => receiveBatch(c, { locationId, note, lines, reference });

  try {
    // The preview posts every line for real and rolls it back, so what
    // it reports is what will happen rather than a second opinion
    // about it. See lib/db.ts withRollback.
    const result = mode === "commit"
      ? await withSession(claims, run)
      : await withRollback(claims, run);

    if (mode === "commit") {
      revalidatePath("/stock");
      revalidatePath("/products");
      revalidatePath("/");
    }

    return {
      mode,
      rows: result.rows,
      units: result.units,
      valuePaise: result.valuePaise,
      received: result.rows.filter((r) => r.status === "RECEIVED").length,
      failed: result.rows.filter((r) => r.status === "FAILED").length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...empty, fatal: msg.replace(/^[A-Z_]+:\s*/, "") };
  }
}
