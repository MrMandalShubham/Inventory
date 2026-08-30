// Rebuild the LOCAL container from nothing.
//
//   npm run db:reset
//
// This is the test database, and only ever the test database. The
// deployed system runs on Supabase now (see .env.local), so the steps
// below force DATABASE_URL to the local container rather than letting
// .env.local decide — otherwise `db:reset` would quietly point the
// demo seed at production and be refused, or worse, not be.
//
// Deployed databases are never "reset". They are migrated forward:
//
//   npm run db:migrate
//   npm run db:jobs
//   npm run db:verify

import { spawnSync } from "node:child_process";
import { LOCAL_CONNECTION } from "./db-config.mjs";

const steps = [
  ["node", ["scripts/db-down.mjs"]],
  ["node", ["scripts/db-up.mjs"]],
  ["node", ["scripts/migrate.mjs"]],
  ["node", ["scripts/seed.mjs"]],
  ["npx", ["tsx", "scripts/demo-images.mjs"]],
];

for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // The whole point of this file.
      DATABASE_URL: LOCAL_CONNECTION,
      // Demo images against the local container belong on local disk,
      // not in the production bucket.
      STORAGE_DRIVER: "local",
    },
  });

  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(" ")} failed — stopping.\n`);
    process.exit(r.status ?? 1);
  }
}
