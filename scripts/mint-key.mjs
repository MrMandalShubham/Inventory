// Mint an API key from the command line.
//
//   npm run key:mint -- --name "Storefront" --scopes catalog:read,stock:read,reservations:write --locations SH1
//
// The dashboard at /api-keys does the same thing and is the normal
// route. This exists because minting a key through the dashboard
// requires the dashboard to be reachable and the login to work — and
// the first key you need is usually the one you want while you are
// still proving the deployment. A credential you cannot mint until
// everything else works is a credential you cannot bootstrap with.
//
// The key is printed ONCE. Only its SHA-256 is stored, so there is no
// second chance and no query that will give it back: lose it, revoke
// it, mint another.

import "./env.mjs";
import pg from "pg";
import { connectionOptions } from "./db-config.mjs";

const ADMIN_ROLE_CLAIMS = { role: "admin", all_locations: true, location_ids: "" };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const name = arg("name", "Storefront");
const environment = arg("env", "LIVE").toUpperCase();
const scopes = arg("scopes", "catalog:read,stock:read,reservations:write")
  .split(",").map((s) => s.trim()).filter(Boolean);
const locationCodes = (arg("locations") ?? "")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

if (!["LIVE", "SANDBOX"].includes(environment)) {
  console.error(`--env must be LIVE or SANDBOX, not ${environment}`);
  process.exit(1);
}

const db = new pg.Client(connectionOptions());
await db.connect();

try {
  // create_api_client is admin-only, and checks the role from the
  // request claims rather than from the connection — so a script must
  // say who it is, the same as a request does.
  await db.query("select set_config('request.jwt.claims', $1, false)",
    [JSON.stringify(ADMIN_ROLE_CLAIMS)]);

  // Codes in, uuids out. Nobody should have to look up a uuid to bind
  // a key to the shop whose sign says SH1.
  let locationIds = [];
  if (locationCodes.length > 0) {
    const { rows } = await db.query(
      `select id, code from platform.location
        where upper(code) = any($1) and status = 'ACTIVE'`, [locationCodes]);

    const found = rows.map((r) => r.code.toUpperCase());
    const missing = locationCodes.filter((c) => !found.includes(c));

    // Refuse rather than silently minting a key bound to fewer shops
    // than asked for — that key would work, and fail only later, at a
    // shop somebody assumed it covered.
    if (missing.length > 0) {
      const all = (await db.query(
        "select code, name from platform.location where status='ACTIVE' order by code")).rows;
      console.error(`\nNo such location: ${missing.join(", ")}\n`);
      console.error("Locations that exist:");
      for (const l of all) console.error(`  ${l.code.padEnd(8)} ${l.name}`);
      process.exit(1);
    }
    locationIds = rows.map((r) => r.id);
  }

  const { rows: [key] } = await db.query(
    "select * from platform.create_api_client($1, $2, $3::uuid[], $4)",
    [name, scopes, locationIds, environment]);

  console.log(`
  ${name} — ${environment}

  ${key.api_key}

  scopes     ${scopes.join(", ")}
  locations  ${locationCodes.length ? locationCodes.join(", ") : "ALL — this key may sell from every shop"}

  Shown once. Store it as INVENTORY_API_KEY on the calling app, server
  side only. Revoke it at /api-keys if it ever reaches a browser.
`);
} finally {
  await db.end();
}
