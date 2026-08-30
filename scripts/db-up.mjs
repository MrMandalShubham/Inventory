// Start the local Postgres used for development and the confirmation tests.
//
// Plain postgres:16 rather than the Supabase CLI: the only Supabase
// pieces these tests need are auth.jwt() and the `authenticated`
// role, and supabase/local/00-auth-shim.sql provides both with the
// same definitions Supabase uses. That keeps the suite fast, and
// runnable in CI without pulling the whole Supabase stack.

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { CONTAINER, PORT, PASSWORD, DB } from "./db-config.mjs";

const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts }).trim();

function exists() {
  try {
    return run(`docker ps -aq --filter name=^${CONTAINER}$`).length > 0;
  } catch {
    return false;
  }
}

function running() {
  try {
    return run(`docker ps -q --filter name=^${CONTAINER}$`).length > 0;
  } catch {
    return false;
  }
}

try {
  run("docker info --format {{.ServerVersion}}");
} catch {
  console.error("Docker is not running. Start Docker Desktop and try again.");
  process.exit(1);
}

if (running()) {
  console.log(`• ${CONTAINER} already running on :${PORT}`);
} else if (exists()) {
  run(`docker start ${CONTAINER}`);
  console.log(`• started existing ${CONTAINER} on :${PORT}`);
} else {
  run(
    `docker run -d --name ${CONTAINER} ` +
      `-e POSTGRES_PASSWORD=${PASSWORD} -e POSTGRES_DB=${DB} ` +
      `-p ${PORT}:5432 postgres:16-alpine`,
  );
  console.log(`• created ${CONTAINER} on :${PORT}`);
}

// Readiness. The container reports ready once briefly during init
// before restarting, so require several consecutive successes.
let streak = 0;
for (let i = 0; i < 60; i++) {
  try {
    run(`docker exec ${CONTAINER} pg_isready -U postgres -d ${DB}`);
    if (++streak >= 3) {
      console.log("• postgres accepting connections");
      process.exit(0);
    }
  } catch {
    streak = 0;
  }
  await sleep(500);
}

console.error("Postgres did not become ready within 30s.");
process.exit(1);
