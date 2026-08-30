"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";

/** Every one of these calls stock.post_movement, directly or through
 *  a wrapper. There is no other door — see migration 0013. */

export async function postAdjustment(formData: FormData) {
  const claims = await currentClaims();
  const [product, location] = String(formData.get("line") ?? "").split("|");
  const delta = Number(formData.get("delta"));
  const reason = String(formData.get("reason") ?? "").trim();
  const back = String(formData.get("back") ?? "/stock");

  try {
    await withSession(claims, async (c) => {
      await c.query("select stock.post_adjustment($1,$2,$3,$4)", [product, location, delta, reason]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`${back}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/stock");
  redirect(`${back}?ok=${encodeURIComponent(`adjusted by ${delta > 0 ? "+" : ""}${delta}`)}`);
}

export async function recordWastage(formData: FormData) {
  const claims = await currentClaims();
  const [product, location] = String(formData.get("line") ?? "").split("|");
  const qty = Number(formData.get("qty"));
  const note = String(formData.get("note") ?? "").trim();
  const back = String(formData.get("back") ?? "/stock");

  try {
    await withSession(claims, async (c) => {
      await c.query("select stock.record_wastage($1,$2,$3,$4)", [product, location, qty, note]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`${back}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/stock");
  redirect(`${back}?ok=${encodeURIComponent(`${qty} written off`)}`);
}

export async function openCountSheet(formData: FormData) {
  const claims = await currentClaims();
  const location = String(formData.get("location_id"));
  const note = String(formData.get("note") ?? "").trim() || null;

  let id: string;
  try {
    id = await withSession(claims, async (c) => {
      const { rows } = await c.query("select stock.open_count_sheet($1,$2) as id", [location, note]);
      return rows[0].id as string;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/counts?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/counts");
  redirect(`/counts/${id}`);
}

export async function recordCount(formData: FormData) {
  const claims = await currentClaims();
  const line = String(formData.get("line_id"));
  const counted = Number(formData.get("counted_qty"));
  const sheet = String(formData.get("sheet_id"));

  try {
    await withSession(claims, async (c) => {
      await c.query("select stock.record_count($1,$2)", [line, counted]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/counts/${sheet}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath(`/counts/${sheet}`);
  redirect(`/counts/${sheet}`);
}

export async function submitCountSheet(formData: FormData) {
  const claims = await currentClaims();
  const sheet = String(formData.get("sheet_id"));

  let variances = 0;
  try {
    variances = await withSession(claims, async (c) => {
      const { rows } = await c.query("select stock.submit_count_sheet($1) as n", [sheet]);
      return rows[0].n as number;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/counts/${sheet}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath(`/counts/${sheet}`);
  redirect(`/counts/${sheet}?ok=${encodeURIComponent(
    variances === 0 ? "submitted — no variances" : `submitted — ${variances} variance(s) to approve`)}`);
}

export async function approveCountSheet(formData: FormData) {
  const claims = await currentClaims();
  const sheet = String(formData.get("sheet_id"));

  let posted = 0;
  try {
    posted = await withSession(claims, async (c) => {
      const { rows } = await c.query("select stock.approve_count_sheet($1) as n", [sheet]);
      return rows[0].n as number;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/counts/${sheet}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/stock");
  revalidatePath(`/counts/${sheet}`);
  redirect(`/counts/${sheet}?ok=${encodeURIComponent(`approved — ${posted} variance(s) posted to the ledger`)}`);
}
