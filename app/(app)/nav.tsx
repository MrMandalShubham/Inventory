"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type Item = { href: string; label: string; icon: string };

export function NavLink({ href, label, icon }: Item) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-teal-50 text-teal-700 font-semibold"
          : "text-ink-700 hover:bg-ink-50",
      ].join(" ")}
    >
      <span aria-hidden className="w-4 text-center opacity-60">{icon}</span>
      {label}
    </Link>
  );
}

/**
 * Mobile chrome.
 *
 * The operator personas live on a phone, so the primary actions have
 * to be reachable with a thumb. The drawer is a plain checkbox-free
 * useState toggle rather than a modal library — it has one job.
 */
export function MobileNav({
  nav, name, role, scope, signOut,
}: {
  nav: Item[];
  name: string;
  role: string;
  scope: string;
  signOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  return (
    <>
      <header className="md:hidden sticky top-0 z-30 flex items-center gap-3 border-b border-ink-100 bg-white px-4 py-3 no-print">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded bg-teal-600 text-white text-[10px] font-bold">
            IC
          </span>
          <span className="font-semibold text-sm tracking-tight">Inventory Core</span>
        </Link>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          className="ml-auto rounded-md border border-ink-200 px-3 py-1.5 text-sm"
        >
          {open ? "Close" : "Menu"}
        </button>
      </header>

      {open && (
        <div className="md:hidden border-b border-ink-100 bg-white no-print">
          <nav className="p-3 space-y-0.5">
            {nav.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setOpen(false)}
                  className={[
                    "flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[15px]",
                    active ? "bg-teal-50 text-teal-700 font-semibold" : "text-ink-700",
                  ].join(" ")}
                >
                  <span aria-hidden className="w-4 text-center opacity-60">{n.icon}</span>
                  {n.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-ink-100 p-3">
            <div className="px-2 pb-2">
              <div className="text-[13px] font-semibold">{name}</div>
              <div className="meta capitalize">{role} · {scope}</div>
            </div>
            <form action={signOut}>
              <button type="submit" className="btn btn-ghost w-full text-[13px] py-2">
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
