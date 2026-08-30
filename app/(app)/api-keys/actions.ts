"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withSession } from "@/lib/db";
import { currentClaims } from "@/lib/session";

export async function createKey(formData: FormData) {
  const claims = await currentClaims();
  const name = String(formData.get("name") ?? "").trim();
  const scopes = formData.getAll("scopes").map(String);
  const environment = String(formData.get("environment") ?? "LIVE");
  const locations = formData.getAll("locations").map(String).filter(Boolean);

  if (!name || scopes.length === 0) {
    redirect(`/api-keys?error=${encodeURIComponent("A name and at least one scope are required.")}`);
  }

  let key: string;
  try {
    key = await withSession(claims, async (c) => {
      const { rows } = await c.query(
        `select * from platform.create_api_client($1,$2,$3::uuid[],$4)`,
        [name, scopes, locations, environment]);
      return rows[0].api_key as string;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/api-keys?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/api-keys");
  // Shown once, in the URL, and never stored anywhere we can read it.
  redirect(`/api-keys?created=${encodeURIComponent(key)}`);
}

export async function revokeKey(formData: FormData) {
  const claims = await currentClaims();
  const id = String(formData.get("id"));

  try {
    await withSession(claims, async (c) => {
      await c.query("update platform.api_client set status='REVOKED' where id=$1", [id]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/api-keys?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/api-keys");
  redirect(`/api-keys?ok=${encodeURIComponent("key revoked — it stops working immediately")}`);
}

export async function setLimits(formData: FormData) {
  const claims = await currentClaims();
  const id = String(formData.get("id"));

  // Blank means "leave it alone", which is different from zero. The
  // function refuses a zero rate outright, because that would lock
  // the client out entirely rather than slow it down.
  const num = (k: string) => {
    const raw = String(formData.get(k) ?? "").trim();
    return raw === "" ? null : Number(raw);
  };
  const clearQuota = formData.get("clear_quota") === "on";

  try {
    await withSession(claims, async (c) => {
      await c.query("select platform.set_api_limits($1,$2,$3,$4,$5)",
        [id, num("per_min"), num("burst"), num("daily_quota"), clearQuota]);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/api-keys?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/api-keys");
  redirect(`/api-keys?ok=${encodeURIComponent("limits updated — they take effect on the next request")}`);
}

export async function setSubscriptionStatus(formData: FormData) {
  const claims = await currentClaims();
  const id = String(formData.get("id"));
  const status = String(formData.get("status")) === "PAUSED" ? "PAUSED" : "ACTIVE";

  try {
    await withSession(claims, async (c) => {
      await c.query(
        "update platform.webhook_subscription set status=$2 where id=$1", [id, status]);
      // Resuming clears the failure streak, so the health screen shows
      // whether it is working NOW rather than what it did last week.
      if (status === "ACTIVE") {
        await c.query(
          "update platform.webhook_subscription set consecutive_failures = 0 where id=$1", [id]);
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/api-keys?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/api-keys");
  redirect(`/api-keys?ok=${encodeURIComponent(
    status === "PAUSED"
      ? "subscription paused — new events will not be queued for it"
      : "subscription resumed")}`);
}

export async function retryDeadDeliveries(formData: FormData) {
  const claims = await currentClaims();
  const id = String(formData.get("id"));

  let n = 0;
  try {
    n = await withSession(claims, async (c) => {
      // Through the function, not a direct UPDATE: webhook_delivery
      // has no write policy, and opening one for a single screen
      // would be the first hole in "the queue has one door".
      const { rows } = await c.query(
        "select platform.retry_dead_deliveries($1) as n", [id]);
      return Number(rows[0].n);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    redirect(`/api-keys?error=${encodeURIComponent(msg)}`);
  }

  revalidatePath("/api-keys");
  redirect(`/api-keys?ok=${encodeURIComponent(
    `${n} dead deliver${n === 1 ? "y" : "ies"} requeued — the worker will pick them up`)}`);
}
