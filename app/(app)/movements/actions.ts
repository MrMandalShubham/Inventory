"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";

async function call<T>(sql: string, params: unknown[], back: string): Promise<T> {
  const claims = await currentClaims();
  try {
    return await withSession(claims, async (c) => {
      const { rows } = await c.query(sql, params);
      return rows[0] as T;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`${back}?error=${encodeURIComponent(msg)}`);
  }
}

export async function createMovement(formData: FormData) {
  const type = String(formData.get("type"));
  const source = String(formData.get("source") ?? "") || null;
  const dest = String(formData.get("dest") ?? "") || null;
  const partner = String(formData.get("partner") ?? "") || null;
  const note = String(formData.get("note") ?? "").trim() || null;

  // One product per ticket in the working UI. Multi-line pickers are
  // Phase 5; the underlying function already takes any number.
  const lines = [{
    product_id: String(formData.get("product_id")),
    qty: Number(formData.get("qty")),
    unit_cost: String(formData.get("unit_cost") ?? "") || null,
  }];

  const row = await call<{ id: string }>(
    "select movement.create_movement($1,$2,$3,$4,$5::jsonb,$6) as id",
    [type, type === "IMPORT" ? null : source, type === "EXPORT" ? null : dest,
     type === "TRANSFER" ? null : partner, JSON.stringify(lines), note],
    "/movements/new");

  revalidatePath("/movements");
  redirect(`/movements/${row.id}`);
}

export async function approveMovement(formData: FormData) {
  const id = String(formData.get("id"));
  await call("select movement.approve_movement($1)", [id], `/movements/${id}`);
  revalidatePath(`/movements/${id}`);
  redirect(`/movements/${id}?ok=${encodeURIComponent("approved")}`);
}

export async function dispatchMovement(formData: FormData) {
  const id = String(formData.get("id"));
  const lineId = String(formData.get("line_id") ?? "");
  const qty = String(formData.get("qty") ?? "");

  const lines = lineId && qty ? [{ line_id: lineId, qty: Number(qty) }] : null;

  const row = await call<{ n: number }>(
    "select movement.dispatch_movement($1,$2::jsonb) as n",
    [id, lines ? JSON.stringify(lines) : null], `/movements/${id}`);

  revalidatePath("/stock");
  revalidatePath(`/movements/${id}`);
  redirect(`/movements/${id}?ok=${encodeURIComponent(`${row.n} unit(s) dispatched into transit`)}`);
}

export async function receiveMovement(formData: FormData) {
  const id = String(formData.get("id"));
  const back = String(formData.get("back") ?? `/movements/${id}`);

  // Lines arrive as recv_<lineId> / rej_<lineId> / why_<lineId>.
  const lines: Record<string, any>[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("recv_")) continue;
    const lineId = key.slice(5);
    lines.push({
      line_id: lineId,
      qty_received: Number(value),
      qty_rejected: Number(formData.get(`rej_${lineId}`) ?? 0) || 0,
      reject_reason: String(formData.get(`why_${lineId}`) ?? "").trim() || null,
    });
  }

  // Freight and charges, if the invoice came with the lorry. These
  // MUST be recorded before the receipt: landed cost is fixed the
  // moment the goods are counted in, and set_charges refuses
  // afterwards. Both statements share one transaction so a receipt
  // can never commit with only half its cost.
  const paise = (k: string) => {
    const raw = String(formData.get(k) ?? "").trim();
    if (!raw) return null;
    const n = Math.round(Number(raw) * 100);
    return Number.isFinite(n) ? n : null;
  };
  const freight = paise("freight");
  const other = paise("other_charges");

  const claims = await currentClaims();
  let row: { s: string };
  try {
    row = await withSession(claims, async (c) => {
      await c.query("begin");
      try {
        if (freight !== null || other !== null) {
          await c.query("select movement.set_charges($1,$2,$3)", [id, freight, other]);
        }
        const { rows } = await c.query(
          "select movement.receive_movement($1,$2::jsonb) as s",
          [id, JSON.stringify(lines)]);
        await c.query("commit");
        return rows[0] as { s: string };
      } catch (e) {
        await c.query("rollback");
        throw e;
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`${back}?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/stock");
  revalidatePath(`/movements/${id}`);

  redirect(`/movements/${id}?ok=${encodeURIComponent(
    row.s === "CLOSED"
      ? "counts matched — the ticket closed itself"
      : "counts differ — this ticket cannot close until every unit is explained")}`);
}

export async function resolveDiscrepancy(formData: FormData) {
  const id = String(formData.get("id"));
  const reason = String(formData.get("reason") ?? "").trim();

  const row = await call<{ n: number }>(
    "select movement.resolve_discrepancy($1,$2) as n", [id, reason], `/movements/${id}`);

  revalidatePath("/stock");
  revalidatePath(`/movements/${id}`);
  redirect(`/movements/${id}?ok=${encodeURIComponent(
    `closed — ${row.n} unit(s) written off in transit`)}`);
}

export async function cancelMovement(formData: FormData) {
  const id = String(formData.get("id"));
  const reason = String(formData.get("reason") ?? "").trim();
  await call("select movement.cancel_movement($1,$2)", [id, reason], `/movements/${id}`);
  revalidatePath(`/movements/${id}`);
  redirect(`/movements/${id}?ok=${encodeURIComponent("cancelled")}`);
}
