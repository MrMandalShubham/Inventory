import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { withoutSession } from "@/lib/db";
import {
  SESSION_COOKIE, currentSession, roleLabel, seesEverything,
} from "@/lib/session";
import { NavLink, MobileNav } from "./nav";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await withoutSession((c) => c.query("select platform.sign_out($1)", [token]))
      .catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

/** Everything an operator needs is at the top; everything a planner
 *  needs is below it. The order is the shop floor's, not the schema's. */
const NAV = [
  { href: "/", label: "Overview", icon: "▤" },
  { href: "/stock", label: "Stock", icon: "▦" },
  // Each location has its own dashboard, so this is not an admin
  // screen — it is where a shop manager starts their morning.
  { href: "/locations", label: "Inventories", icon: "⌂" },
  { href: "/movements", label: "Movements", icon: "⇄" },
  { href: "/planning", label: "Replenishment", icon: "⤴" },
  { href: "/alerts", label: "Alerts", icon: "⚑" },
  { href: "/counts", label: "Counts", icon: "☑" },
  { href: "/products", label: "Products", icon: "◫" },
  { href: "/reports", label: "Reports", icon: "▧" },
];

/** Money is role-restricted, so the link is too. An operator who
 *  clicks through to a page of dashes learns the wrong lesson about
 *  their data — better that the door is not there. */
const MONEY_NAV = [
  { href: "/finance", label: "Finance", icon: "₹" },
];

const ADMIN_NAV = [
  { href: "/partners", label: "Partners", icon: "◇" },
  { href: "/import", label: "Import", icon: "↥" },
  { href: "/api-keys", label: "API", icon: "⚿" },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await currentSession();
  if (!me) redirect("/login");

  const money = ["finance", "admin", "planner"].includes(me.role) ? MONEY_NAV : [];

  const scope = seesEverything(me)
    ? "all locations"
    : `${me.location_ids.split(",").filter(Boolean).length} location(s)`;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      {/* ── sidebar: desktop ── */}
      <aside className="hidden md:flex md:flex-col border-r border-ink-100 bg-white no-print">
        <div className="px-5 py-4 border-b border-ink-100">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md bg-teal-600 text-white text-xs font-bold">
              IC
            </span>
            <span className="font-semibold tracking-tight">Inventory Core</span>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
          {[...NAV, ...money].map((n) => <NavLink key={n.href} {...n} />)}

          <div className="eyebrow px-3 pt-5 pb-1.5">Admin</div>
          {ADMIN_NAV.map((n) => <NavLink key={n.href} {...n} />)}
        </nav>

        <div className="border-t border-ink-100 p-3">
          <div className="px-2 pb-2">
            <div className="text-[13px] font-semibold truncate">{me.full_name}</div>
            <div className="meta capitalize">{roleLabel(me.role)} · {scope}</div>
          </div>
          <form action={signOut}>
            <button type="submit" className="btn-ghost btn w-full text-[13px] py-1.5">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* ── top bar: mobile ── */}
      <MobileNav
        nav={[...NAV, ...money, ...ADMIN_NAV]}
        name={me.full_name}
        role={roleLabel(me.role)}
        scope={scope}
        signOut={signOut}
      />

      <div className="min-w-0">
        <main className="mx-auto max-w-[76rem] px-4 py-6 md:px-8 md:py-8 pb-24 md:pb-12">
          {children}
        </main>
      </div>
    </div>
  );
}
