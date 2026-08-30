// Load .env.local / .env for the standalone scripts.
//
// Next.js does this for the app automatically; a script run through
// `tsx` does not. Without it, `npm run storage:check` would read an
// empty environment, fall back to the local driver, pass every
// assertion, and tell you Supabase works when it was never contacted.
//
// A variable already set in the real environment always wins, so a
// one-off `STORAGE_DRIVER=local npm run storage:check` still does what
// it says.

import { readFileSync } from "node:fs";
import { join } from "node:path";

function load(file) {
  let text;
  try {
    text = readFileSync(join(process.cwd(), file), "utf8");
  } catch {
    return;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;   // the shell wins

    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, if present.
    if (value.length > 1 &&
        ((value[0] === '"' && value.at(-1) === '"') ||
         (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

// .env.local last would lose to .env; load it FIRST so it takes
// precedence, since the first writer wins above.
load(".env.local");
load(".env");
