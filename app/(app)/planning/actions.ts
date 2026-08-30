"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";

/**
 * The daily run produces a WORKLIST, not actions.
 *
 * Every suggestion is approved, adjusted or rejected by a person, and
 * a rejection is recorded with its reason — that record is the input
 * to Phase 8's adaptation loop. A system that quietly acts on its own
 * arithmetic teaches nobody anything when it turns out to be wrong.
 */

export async function refreshMetrics(formData: FormData) {
  const claims = await currentClaims();
  const back = String(formData.get("back") ?? "/planning");

  try {
    await withSession(claims, async (c) => {
      await c.query("select insight.refresh_metrics()");
      await c.query("select * from alerting.evaluate()");
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`${back}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/planning");
  revalidatePath("/alerts");
  redirect(`${back}?ok=${encodeURIComponent("recalculated from the ledger")}`);
}

/** Turn a suggestion into a real transfer ticket, still requiring a
 *  second person to approve it like any other movement. */
export async function raiseFromSuggestion(formData: FormData) {
  const claims = await currentClaims();
  const product = String(formData.get("product_id"));
  const dest = String(formData.get("location_id"));
  const source = String(formData.get("source_location_id") ?? "");
  const qty = Number(formData.get("qty"));

  if (!source) {
    redirect(`/planning?error=${encodeURIComponent(
      "No location can give this up without dropping below its own reorder point. " +
      "This needs a purchase order, not a transfer.")}`);
  }

  let id: string;
  try {
    id = await withSession(claims, async (c) => {
      const { rows } = await c.query(
        `select movement.create_movement('TRANSFER',$1,$2,null,$3::jsonb,$4) as id`,
        [source, dest, JSON.stringify([{ product_id: product, qty }]),
         "raised from the replenishment run"]);
      return rows[0].id as string;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/planning?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/planning");
  redirect(`/movements/${id}`);
}

export async function acknowledgeAlert(formData: FormData) {
  const claims = await currentClaims();
  const id = String(formData.get("id"));

  try {
    await withSession(claims, async (c) => {
      await c.query("select alerting.acknowledge($1)", [Number(id)]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/alerts?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/alerts");
  redirect("/alerts");
}
