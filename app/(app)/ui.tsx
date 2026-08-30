import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Shared surfaces for the product UI.
 *
 * Two rules run through all of it:
 *
 * 1. State is encoded in FORM as well as colour — a pill, a severity
 *    dot — so what needs attention reads at a glance and survives a
 *    monochrome print or a colour-blind reader.
 *
 * 2. An empty table says WHY it is empty. "Nothing here" and "you are
 *    not allowed to see this" look identical otherwise, and the second
 *    one silently teaches people the wrong thing about their data.
 */

export function PageHeader({
  title, lede, actions, eyebrow,
}: {
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="h-page">{title}</h1>
        {lede && <p className="lede mt-1.5">{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Tile({
  n, label, tone = "plain", href,
}: {
  n: ReactNode;
  label: string;
  tone?: "plain" | "good" | "warn" | "bad";
  href?: string;
}) {
  const colour = {
    plain: "text-ink-900",
    good: "text-moss-600",
    warn: "text-amber-600",
    bad: "text-rose-600",
  }[tone];

  const inner = (
    <>
      <div className={`tile-n ${colour}`}>{n}</div>
      <div className="tile-l">{label}</div>
    </>
  );

  return href ? (
    <Link href={href} className="tile block transition-colors hover:border-ink-200 hover:bg-ink-50">
      {inner}
    </Link>
  ) : (
    <div className="tile">{inner}</div>
  );
}

export function Pill({
  tone = "plain", children,
}: {
  tone?: "plain" | "good" | "warn" | "bad" | "info";
  children: ReactNode;
}) {
  const cls = {
    plain: "pill", good: "pill pill-good", warn: "pill pill-warn",
    bad: "pill pill-bad", info: "pill pill-info",
  }[tone];
  return <span className={cls}>{children}</span>;
}

/** A severity dot. Form, not just colour — the shape carries meaning
 *  for anyone who cannot separate the hues. */
export function Dot({ tone }: { tone: "good" | "warn" | "bad" | "plain" }) {
  const cls = {
    good: "bg-moss-600", warn: "bg-amber-500",
    bad: "bg-rose-600", plain: "bg-ink-200",
  }[tone];
  const ring = tone === "bad" ? "ring-2 ring-rose-100" : "";
  return <span aria-hidden className={`inline-block size-2 rounded-full ${cls} ${ring}`} />;
}

export function Card({
  children, className = "", pad = true,
}: {
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <div className={`card ${pad ? "card-pad" : ""} ${className}`}>{children}</div>
  );
}

export function Section({ title, action, children }: {
  title: string; action?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="h-sect">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * An empty state that distinguishes "nothing exists" from "your role
 * cannot see this". Getting this wrong told an operator there were no
 * API keys when there were two, and told a shop the ledger was empty
 * when it was simply another location's.
 */
export function Empty({
  children, denied, what,
}: {
  children?: ReactNode;
  denied?: boolean;
  what?: string;
}) {
  return (
    <div className="px-4 py-10 text-center">
      {denied ? (
        <>
          <p className="text-sm font-semibold text-ink-700">Not visible to your role</p>
          <p className="meta mx-auto mt-1 max-w-md">
            The database returned nothing{what ? ` for ${what}` : ""} — this page did not
            filter it out. Rows may well exist.
          </p>
        </>
      ) : (
        <p className="text-sm text-ink-500">{children ?? "Nothing here yet."}</p>
      )}
    </div>
  );
}

export function Notice({
  tone = "info", title, children,
}: {
  tone?: "info" | "warn" | "bad";
  title?: string;
  children: ReactNode;
}) {
  const cls = { info: "notice-info", warn: "notice-warn", bad: "notice-bad" }[tone];
  return (
    <div className={`notice ${cls}`} role={tone === "bad" ? "alert" : undefined}>
      {title && <b className="mr-1">{title}</b>}
      {children}
    </div>
  );
}

/** Wide content scrolls inside its own box; the page body never
 *  scrolls sideways. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="card overflow-x-auto">
      <table className="tbl">{children}</table>
    </div>
  );
}

/**
 * Money.
 *
 * A dash means "not known". Zero means zero, and gets printed —
 * these two used to render identically, because bigint arrives from
 * pg as a string and `!paise` is true for both null and 0. On an
 * accounting screen that difference is the whole point: an account
 * that nets to nothing is a finding, not a blank.
 */
export function Money({ paise, signed = false }: {
  paise: number | string | null | undefined;
  signed?: boolean;
}) {
  if (paise === null || paise === undefined || paise === "") {
    return <span className="text-ink-400">—</span>;
  }
  const n = Number(paise);
  if (Number.isNaN(n)) return <span className="text-ink-400">—</span>;

  const body = `₹${(Math.abs(n) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
  const negative = n < 0;

  return (
    <span className={`tnum ${signed && negative ? "text-rose-600" : ""}`}>
      {negative ? "−" : signed && n > 0 ? "+" : ""}{body}
    </span>
  );
}

export function When({ at, relative = false }: { at: string | Date; relative?: boolean }) {
  const d = new Date(at);
  if (relative) {
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    const label =
      mins < 1 ? "just now" :
      mins < 60 ? `${mins}m ago` :
      mins < 1440 ? `${Math.round(mins / 60)}h ago` :
      `${Math.round(mins / 1440)}d ago`;
    return <time dateTime={d.toISOString()} title={d.toLocaleString("en-GB")}>{label}</time>;
  }
  return (
    <time dateTime={d.toISOString()} className="tnum">
      {d.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
    </time>
  );
}
