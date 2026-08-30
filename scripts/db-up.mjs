// Start the local Postgres used for development and the confirmation tests.
//
// Plain postgres rather than the Supabase CLI: the Supabase pieces
// these tests need are auth.jwt(), the `authenticated` role, and the
// `extensions` schema layout, and supabase/local/ provides all three
// with the same definitions Supabase uses. That keeps the suite fast,
// and runnable in CI without pulling the whole Supabase stack.
//
// The IMAGE matters. It tracks the deployed project's major version,
// because a suite that passes on 16 proves nothing about 17 — and the
// container is recreated automatically when this changes, since a
// stale container is a test run against the version we just left.

import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { CONTAINER, PORT, PASSWORD, DB, IMAGE } from "./db-config.mjs";

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

/** The image an existing container was built from, or null. */
function currentImage() {
  try {
    return run(`docker inspect -f {{.Config.Image}} ${CONTAINER}`) || null;
  } catch {
    return null;
  }
}

// A container left over from an earlier IMAGE is not the database the
// tests are meant to run against. Replace it rather than reusing it:
// the whole reason the version is pinned is that it must match what is
// deployed, and silently honouring a stale one defeats the pin.
const stale = exists() && currentImage() !== IMAGE;

if (stale) {
  console.log(`• replacing ${CONTAINER} — built from ${currentImage()}, want ${IMAGE}`);
  try { run(`docker rm -f ${CONTAINER}`); } catch { /* already gone */ }
}

if (!stale && running()) {
  console.log(`• ${CONTAINER} already running on :${PORT}`);
} else if (!stale && exists()) {
  run(`docker start ${CONTAINER}`);
  console.log(`• started existing ${CONTAINER} on :${PORT}`);
} else {
  run(
    `docker run -d --name ${CONTAINER} ` +
      `-e POSTGRES_PASSWORD=${PASSWORD} -e POSTGRES_DB=${DB} ` +
      `-p ${PORT}:5432 ${IMAGE}`,
  );
  console.log(`• created ${CONTAINER} on :${PORT} from ${IMAGE}`);
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
