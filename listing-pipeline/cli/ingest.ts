/**
 * Folder ingest: pairs *-front.* / *-back.*,
 * uploads to Supabase Storage, creates lp_listing_batches + lp_cards.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, LISTING_EMAIL, LISTING_PASSWORD
 * Args: --dir <path> [--batch name]
 */

import { createClient } from "@supabase/supabase-js";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, extname } from "node:path";
import { createHash } from "node:crypto";

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
]);

async function readFileHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const st = createReadStream(path);
    st.on("error", reject);
    st.on("data", (c: Buffer) => hash.update(c));
    st.on("end", () => resolve(hash.digest("hex")));
  });
}

function parseArgs(): { dir: string; batch?: string } {
  const argv = process.argv.slice(2);
  let dir = "";
  let batch: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = argv[++i];
    } else if (argv[i] === "--batch" && argv[i + 1]) {
      batch = argv[++i];
    }
  }
  if (!dir) throw new Error("Usage: ingest.ts --dir ./photos [--batch name]");
  return { dir, batch };
}

interface Pair {
  base: string;
  front: string;
  back: string;
}

function findPairs(files: string[], baseDir: string): Pair[] {
  const byBase = new Map<string, { front?: string; back?: string }>();
  const frontRe = /^(.+)-front(\.[^.]+)$/i;
  const backRe = /^(.+)-back(\.[^.]+)$/i;

  for (const f of files) {
    const full = join(baseDir, f);
    if (!statSync(full).isFile()) continue;
    const ext = extname(f).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    let side: "front" | "back" | null = null;
    let baseKey = "";
    const fm = f.match(frontRe);
    const bm = f.match(backRe);
    if (fm) {
      side = "front";
      baseKey = fm[1];
    } else if (bm) {
      side = "back";
      baseKey = bm[1];
    } else continue;

    const cur = byBase.get(baseKey) ?? {};
    if (side === "front") cur.front = f;
    else cur.back = f;
    byBase.set(baseKey, cur);
  }

  const pairs: Pair[] = [];
  for (const [base, v] of byBase) {
    if (v.front && v.back) {
      pairs.push({ base, front: v.front, back: v.back });
    }
  }
  return pairs;
}

async function uploadFile(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  batchId: string,
  localPath: string,
): Promise<string> {
  const name = basename(localPath);
  const storagePath = `${userId}/${batchId}/${name}`;
  const body = new Uint8Array(await readFile(localPath));

  const { error } = await supabase.storage
    .from("listing-card-images")
    .upload(storagePath, body, {
      upsert: true,
      contentType: guessContentType(name),
    });
  if (error) throw error;
  return storagePath;
}

function guessContentType(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

async function main() {
  const { dir, batch } = parseArgs();
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.LISTING_EMAIL;
  const password = process.env.LISTING_PASSWORD;

  if (!url || !anon || !email || !password) {
    throw new Error(
      "Set SUPABASE_URL, SUPABASE_ANON_KEY, LISTING_EMAIL, LISTING_PASSWORD",
    );
  }

  const supabase = createClient(url, anon);

  const {
    data: { user },
    error: signErr,
  } = await supabase.auth.signInWithPassword({ email, password });

  if (signErr || !user) {
    throw new Error(signErr?.message ?? "Login failed");
  }

  const files = readdirSync(dir);
  const pairs = findPairs(files, dir);
  if (!pairs.length) {
    console.error(
      "No front/back pairs found. Use names like foo-front.jpg / foo-back.jpg",
    );
    process.exit(1);
  }

  const { data: batchRow, error: bErr } = await supabase
    .from("lp_listing_batches")
    .insert({
      user_id: user.id,
      name: batch ?? basename(dir),
    })
    .select("id")
    .single();

  if (bErr || !batchRow) throw new Error(bErr?.message ?? "batch insert");

  console.log(`Batch ${batchRow.id}: ${pairs.length} pair(s)`);

  for (const p of pairs) {
    const frontPath = join(dir, p.front);
    const backPath = join(dir, p.back);
    const combined =
      (await readFileHash(frontPath)) + ":" + (await readFileHash(backPath));
    const content_hash = createHash("sha256").update(combined).digest("hex");

    const frontStorage = await uploadFile(supabase, user.id, batchRow.id, frontPath);
    const backStorage = await uploadFile(supabase, user.id, batchRow.id, backPath);

    const titleHint = p.base.replace(/[-_]+/g, " ");

    const { error: cErr } = await supabase.from("lp_cards").insert({
      user_id: user.id,
      batch_id: batchRow.id,
      front_image_path: frontStorage,
      back_image_path: backStorage,
      content_hash,
      title_hint: titleHint,
      card_number: null,
      card_set: null,
      card_year: null,
      status: "pending_pricing",
    });

    if (cErr) {
      console.error("Card insert failed", p.base, cErr.message);
    } else {
      console.log("  +", p.base);
    }
  }

  console.log(
    `\nNext: npx tsx cli/call-edge.ts ${batchRow.id}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
