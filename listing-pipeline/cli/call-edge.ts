/**
 * Call Edge Functions with operator session.
 * Usage: npx tsx cli/call-edge.ts bundles <batchId>
 */

import { createClient } from "@supabase/supabase-js";

const batchId = process.argv[2];

async function main() {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.LISTING_EMAIL;
  const password = process.env.LISTING_PASSWORD;

  if (!url || !anon || !email || !password) {
    throw new Error("Set SUPABASE_URL, SUPABASE_ANON_KEY, LISTING_EMAIL, LISTING_PASSWORD");
  }
  if (!batchId) {
    throw new Error("Usage: call-edge.ts <batchId>");
  }

  const supabase = createClient(url, anon);
  const { data: { session }, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !session) throw new Error(error?.message ?? "auth");

  const fnUrl = `${url.replace(/\/$/, "")}/functions/v1/listing-batch-bundles`;
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ batchId }),
  });

  const text = await res.text();
  console.log(res.status, text);
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
