// Set a user's password on whatever database DATABASE_URL points at.
//
//   npm run user:password -- admin@example.com '<the-new-password>'
//
// Goes through platform.set_password(), not a direct UPDATE, so the
// same rules apply as when a person changes their own: bcrypt at cost
// 10, a minimum length, the lockout counter cleared, and every other
// session for that user deleted. Changing a password because somebody
// else had it is pointless if their session stays alive.
//
// ── A note on the shell ──
//
// A password typed as an argument lands in shell history and in the
// process list. That is acceptable for seeding an admin account on a
// system nobody is using yet; it is not how a real one should be
// rotated. For that, set it through the application, or export it and
// pass $NEW_PASSWORD so at least the history keeps the value out.

import "./env.mjs";
import pg from "pg";
import { connectionOptions, CONNECTION } from "./db-config.mjs";

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error(
    "\nUsage: npm run user:password -- <email> <password>\n\n" +
    "  npm run user:password -- admin@example.com '<the-new-password>'\n\n" +
    "  Never put a real password in a committed example. The first draft of\n" +
    "  this file used the actual admin password here, and the pre-push secret\n" +
    "  scan is the only reason it did not reach GitHub.\n");
  process.exit(1);
}

const c = new pg.Client(connectionOptions());
await c.connect();

try {
  console.log(`\nTarget: ${new URL(CONNECTION).hostname}`);
} catch { /* unparseable */ }

// set_password is admin-only. Say who is asking rather than reaching
// past the check — the point of the function is that the rule is in
// one place.
const admin = (await c.query(
  "select id, full_name, role from platform.app_user where role = 'admin' order by created_at limit 1")).rows[0];

if (!admin) {
  console.error("\nNo admin user exists on this database. Seed it first.\n");
  process.exit(1);
}

await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({
  sub: admin.id, role: "admin", all_locations: true, location_ids: "",
})]);

const user = (await c.query(
  "select id, full_name, role, status from platform.app_user where lower(email) = lower($1)",
  [email])).rows[0];

if (!user) {
  const known = (await c.query(
    "select email, role from platform.app_user order by email")).rows;
  console.error(
    `\nNo user with email ${email}.\n\n  Users on this database:\n` +
    known.map((u) => `    ${u.email.padEnd(28)} ${u.role}`).join("\n") + "\n");
  process.exit(1);
}

const sessionsBefore = Number((await c.query(
  "select count(*)::int n from platform.session where user_id = $1", [user.id])).rows[0].n);

await c.query("select platform.set_password($1, $2)", [user.id, password]);

console.log(`\n  ✔ password set for ${email} (${user.full_name}, ${user.role})`);
if (sessionsBefore > 0) {
  console.log(`  ✔ ${sessionsBefore} existing session(s) ended`);
}

// ── prove it, rather than assume it ──
//
// sign_in returns zero rows for a bad password rather than raising
// (migration 0023), so "no error" is not evidence of anything.

const good = await c.query("select * from platform.sign_in($1, $2)", [email, password]);
if (good.rows.length === 1) {
  console.log("  ✔ signing in with the new password works");
} else {
  console.log("  ✖ the new password does NOT sign in — something is wrong");
  process.exitCode = 1;
}

// And clean up the session that check just created, so verifying does
// not leave a live credential lying around.
const token = good.rows[0] ? Object.values(good.rows[0])[0] : null;
if (token) await c.query("select platform.sign_out($1)", [token]);

console.log("");
await c.end();
