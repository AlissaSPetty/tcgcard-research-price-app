/**
 * List all image objects in Storage bucket listing-card-images (recursive).
 *
 * Default (user JWT): RLS applies — you only see objects whose key starts with
 * `{your auth user id}/` (see migration policy listing_images_select_own). If you
 * uploaded to another prefix, this list is empty even though the dashboard shows files.
 *
 * --admin: use SUPABASE_SERVICE_ROLE_KEY to list every object (bypasses RLS). Local only.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, LISTING_EMAIL, LISTING_PASSWORD
 * Optional: SUPABASE_SERVICE_ROLE_KEY (with --admin)
 * Optional: --prefix path/under/bucket  --admin
 */

import { createClient } from "@supabase/supabase-js";

const BUCKET = "listing-card-images";
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i;

function parseArgs(): { prefix: string; admin: boolean } {
  const argv = process.argv.slice(2);
  let prefix = "";
  let admin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--prefix" && argv[i + 1]) prefix = argv[++i].replace(/^\/+|\/+$/g, "");
    else if (argv[i] === "--admin") admin = true;
  }
  return { prefix, admin };
}

async function listFolder(
  supabase: ReturnType<typeof createClient>,
  prefix: string,
): Promise<{ name: string; metadata: Record<string, unknown> | null }[]> {
  const out: { name: string; metadata: Record<string, unknown> | null }[] = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    const batch = data ?? [];
    if (batch.length === 0) break;
    for (const row of batch) {
      out.push({
        name: row.name,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      });
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

/** Recursively collect object keys. Folders have metadata === null. */
async function listAllKeys(
  supabase: ReturnType<typeof createClient>,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  const rows = await listFolder(supabase, prefix);
  for (const row of rows) {
    const path = prefix ? `${prefix}/${row.name}` : row.name;
    if (row.metadata === null) {
      keys.push(...(await listAllKeys(supabase, path)));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

async function main() {
  const { prefix, admin } = parseArgs();
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.LISTING_EMAIL;
  const password = process.env.LISTING_PASSWORD;

  if (!url || !anon) {
    throw new Error("Set SUPABASE_URL and SUPABASE_ANON_KEY");
  }

  let supabase: ReturnType<typeof createClient>;
  let userIdLabel = "";

  if (admin) {
    if (!serviceRole) {
      throw new Error(
        "--admin requires SUPABASE_SERVICE_ROLE_KEY in env (never commit this key)",
      );
    }
    supabase = createClient(url, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    userIdLabel = "service_role (bypasses RLS)";
  } else {
    if (!email || !password) {
      throw new Error(
        "Set LISTING_EMAIL, LISTING_PASSWORD (or use --admin with SUPABASE_SERVICE_ROLE_KEY)",
      );
    }
    supabase = createClient(url, anon);
    const {
      data: { user },
      error: signErr,
    } = await supabase.auth.signInWithPassword({ email, password });

    if (signErr || !user) {
      throw new Error(signErr?.message ?? "Login failed");
    }
    userIdLabel = user.id;
  }

  const allKeys = await listAllKeys(supabase, prefix);
  const images = allKeys.filter((k) => IMAGE_EXT.test(k));

  console.log(`Bucket: ${BUCKET}${prefix ? ` (prefix: ${prefix}/)` : ""}`);
  console.log(`Mode: ${admin ? "admin" : "user JWT"}`);
  console.log(`User / role: ${userIdLabel}`);
  console.log(`Total objects: ${allKeys.length}, image files: ${images.length}\n`);

  for (const key of images.sort()) {
    console.log(key);
  }

  if (!admin && allKeys.length === 0) {
    console.log(
      `\nNote: With a normal login, Storage RLS only allows SELECT when the object key\n` +
        `starts with YOUR user id as the first path segment (e.g. ${userIdLabel}/photo.jpg).\n` +
        `Uploads at the bucket root or under another folder name are invisible to this API.\n` +
        `Confirm in the dashboard that files live under your user id folder, or run with\n` +
        `  npm run list-bucket-images -- --admin\n` +
        `(SUPABASE_SERVICE_ROLE_KEY in env) to see every object in the bucket.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
