// Collect image objects nothing references any more.
//
// Removing an image row deliberately does NOT delete its bytes
// (migration 0041): the same content-addressed object may be attached
// to another product, and deleting it there and then would blank that
// product's photograph too.
//
// So deletion is a separate, deliberate pass. It lists the bucket —
// which only the storage driver can do — and asks the database one
// question per key.
//
//   node scripts/storage-gc.mjs           # report only
//   node scripts/storage-gc.mjs --delete  # actually remove them
//
// Dry by default. A script whose mistake is unrecoverable should make
// you type something extra.

import "./env.mjs";
import pg from "pg";
import { connectionOptions } from "./db-config.mjs";
import { storage } from "../lib/storage.ts";

const doDelete = process.argv.includes("--delete");

const ADMIN = {
  sub: "22222222-2222-4222-8222-000000000005",
  role: "admin", location_ids: "", all_locations: true,
};

const c = new pg.Client(connectionOptions());
await c.connect();
await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(ADMIN)]);

const keys = await storage().list("products");
console.log(`\n${keys.length} object(s) in the store\n`);

const orphans = [];
for (const key of keys) {
  const { rows } = await c.query("select catalog.image_key_referenced($1) as yes", [key]);
  if (!rows[0].yes) orphans.push(key);
}

if (orphans.length === 0) {
  console.log("Nothing to collect — every object is still referenced.\n");
} else {
  console.log(`${orphans.length} unreferenced:\n`);
  for (const k of orphans) console.log(`  ${k}`);

  if (doDelete) {
    for (const k of orphans) await storage().remove(k);
    console.log(`\nDeleted ${orphans.length}.\n`);
  } else {
    console.log("\nDry run. Pass --delete to remove them.\n");
  }
}

await c.end();
