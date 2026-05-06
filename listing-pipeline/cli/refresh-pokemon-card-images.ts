/**
 * Full tcgcsv.com → pokemon_card_images upsert (TCGPlayer product catalog by set/group).
 * Loops until the Edge Function reports done (batched by group to avoid Edge timeouts).
 *
 * Auth (either):
 *   - LISTING_CRON_SECRET + SUPABASE_URL → x-cron-secret header
 *   - LISTING_EMAIL + LISTING_PASSWORD + SUPABASE_URL + SUPABASE_ANON_KEY → Bearer session
 *
 * Example:
 *   cd listing-pipeline && npm run refresh-pokemon-cards
 * (loads `.env` from this package or repo root)
 */

import { createClient } from "@supabase/supabase-js";
import { loadEnvFromProjectRoot } from "./load-env.ts";

loadEnvFromProjectRoot();

type IngestResponse = {
  ok?: boolean;
  done?: boolean;
  nextStartGroupIndex?: number | null;
  rowsUpserted?: number;
  startGroupIndex?: number;
  endGroupIndex?: number;
  totalGroups?: number;
  errors?: string[];
};

async function main() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  if (!url) throw new Error("Set SUPABASE_URL");

  const fnUrl = `${url}/functions/v1/pokemon-card-images-ingest`;
  const cron = process.env.LISTING_CRON_SECRET?.trim();
  const email = process.env.LISTING_EMAIL;
  const password = process.env.LISTING_PASSWORD;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (cron) {
    headers["x-cron-secret"] = cron;
  } else if (email && password) {
    const anon = process.env.SUPABASE_ANON_KEY;
    if (!anon) throw new Error("Set SUPABASE_ANON_KEY for operator auth");
    const supabase = createClient(url, anon);
    const { data: { session }, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !session) throw new Error(error?.message ?? "auth failed");
    headers["Authorization"] = `Bearer ${session.access_token}`;
  } else {
    throw new Error(
      "Set LISTING_CRON_SECRET or (LISTING_EMAIL + LISTING_PASSWORD + SUPABASE_ANON_KEY)",
    );
  }

  let startGroupIndex = 0;
  let totalRows = 0;
  let batch = 0;

  for (;;) {
    batch += 1;
    const body = JSON.stringify({ startGroupIndex });
    console.error("POST", fnUrl, "body:", body);
    const res = await fetch(fnUrl, {
      method: "POST",
      headers,
      body,
    });
    const text = await res.text();
    let parsed: IngestResponse;
    try {
      parsed = JSON.parse(text) as IngestResponse;
    } catch {
      console.error(text);
      throw new Error(`Non-JSON response (${res.status})`);
    }

    console.log(text);
    if (!res.ok || parsed.ok === false) {
      process.exit(1);
    }

    totalRows += parsed.rowsUpserted ?? 0;

    if (parsed.done === true) {
      console.error(
        `Finished (${batch} batch(es), ~${totalRows} row upserts this run).`,
      );
      break;
    }

    const next = parsed.nextStartGroupIndex;
    if (next == null || next < 0) {
      console.error(
        `Finished (${batch} batch(es), ~${totalRows} row upserts this run).`,
      );
      break;
    }

    startGroupIndex = next;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
