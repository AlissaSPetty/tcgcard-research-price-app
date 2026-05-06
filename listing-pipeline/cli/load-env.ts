import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/** Load the first `.env` found walking up from this file (e.g. `listing-pipeline/.env` or repo root). */
export function loadEnvFromProjectRoot(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const path = join(dir, ".env");
    if (existsSync(path)) {
      config({ path });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
