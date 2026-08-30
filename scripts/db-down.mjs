// Remove the local database container and its data.
// Destructive by design — this is the reset path, not a stop button.

import { execSync } from "node:child_process";
import { CONTAINER } from "./db-config.mjs";

try {
  execSync(`docker rm -f ${CONTAINER}`, { stdio: "pipe" });
  console.log(`• removed ${CONTAINER}`);
} catch {
  console.log(`• ${CONTAINER} not present`);
}
