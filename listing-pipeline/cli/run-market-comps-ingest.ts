/**
 * POST market-comps-ingest until the function reports `completed` (eBay Browse → market_rss_cards).
 *
 * Auth (either):
 *   - LISTING_CRON_SECRET + SUPABASE_URL → x-cron-secret header
 *   - LISTING_EMAIL + LISTING_PASSWORD + SUPABASE_URL + SUPABASE_ANON_KEY → Bearer session
 *
 * Default order is **stale-first** (keyset cursor): coldest comps before recently updated cards.
 * Legacy **id** + **offset** pagination: `MARKET_COMPS_ORDER=id` or `--order=id` (use `--offset`).
 *
 * Example:
 *   cd listing-pipeline && npm run market-comps-ingest
 *   MARKET_COMPS_ORDER=id npm run market-comps-ingest -- --offset 500
 * (loads `.env` from this package or repo root)
 */

import { createClient } from "@supabase/supabase-js";
import { fetchEdgeFunctionJson } from "./fetch-edge-function-json.ts";
import { loadEnvFromProjectRoot } from "./load-env.ts";

loadEnvFromProjectRoot();

function parseOffsetArg(argv: string[]): number {
  let offset = 0;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offset" || a === "-o") {
      const v = argv[++i];
      if (v == null) throw new Error("--offset requires a non-negative integer");
      offset = Number(v);
      if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
        throw new Error("--offset must be a non-negative integer");
      }
    } else if (a.startsWith("--offset=")) {
      offset = Number(a.slice("--offset=".length));
      if (!Number.isFinite(offset) || offset < 0 || !Number.isInteger(offset)) {
        throw new Error("--offset must be a non-negative integer");
      }
    }
  }
  return offset;
}

function useIdOrderMode(argv: string[]): boolean {
  if (argv.includes("--order=id")) return true;
  const env = process.env.MARKET_COMPS_ORDER?.trim().toLowerCase();
  return env === "id";
}

type CompsResponse = {
  ok?: boolean;
  error?: string;
  /** Supabase Edge when the isolate exceeds CPU/memory budget */
  code?: string;
  message?: string;
  completed?: boolean;
  order?: string;
  nextOffset?: number;
  offset?: number;
  nextCursor?: { lastAt?: string; id?: string } | null;
  partial?: boolean;
  browseSearches?: number;
  pokemonCardsInBatch?: number;
};

async function main() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  if (!url) throw new Error("Set SUPABASE_URL");

  const fnUrl = `${url}/functions/v1/market-comps-ingest`;
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

  const idMode = useIdOrderMode(process.argv);
  let offset = parseOffsetArg(process.argv);
  let cursorLastAt: string | null = null;
  let cursorId: string | null = null;
  let batch = 0;

  for (;;) {
    batch += 1;
    const bodyObj = idMode
      ? { offset, order: "id" as const }
      : cursorLastAt && cursorId
      ? { order: "stale" as const, cursorLastAt, cursorId }
      : { order: "stale" as const };
    const body = JSON.stringify(bodyObj);
    console.error("POST", fnUrl, "body:", body);
    const { res, parsed, text } = await fetchEdgeFunctionJson<CompsResponse>(
      fnUrl,
      {
        method: "POST",
        headers,
        body,
      },
      {
        name: "market-comps-ingest",
        hint504:
          "Edge hit 504 or WORKER_LIMIT (too much work per request). Set MARKET_COMPS_BATCH_SIZE=1, MARKET_COMPS_MAX_LISTINGS_PER_SEARCH=2–3, MARKET_COMPS_BROWSE_MAX_RETRIES=3, and keep MARKET_COMPS_SEARCH_DELAY_MS moderate; redeploy market-comps-ingest.",
      },
    );

    console.log(text);
    if (!res.ok || parsed.error || parsed.code === "WORKER_LIMIT") {
      if (parsed.code === "WORKER_LIMIT" || /WORKER_LIMIT|compute resources/i.test(parsed.message ?? "")) {
        console.error(
          "Edge WORKER_LIMIT: reduce work per invocation (see README / MARKET_COMPS_* secrets), redeploy, then retry.",
        );
      }
      process.exit(1);
    }

    if (parsed.completed === true) {
      console.error(
        `Finished (${batch} Edge invocation(s); order=${parsed.order ?? "?"}).`,
      );
      break;
    }

    if (idMode) {
      const next = parsed.nextOffset;
      if (next == null || !Number.isFinite(next)) {
        console.error(
          `Finished (${batch} Edge invocation(s); missing nextOffset).`,
        );
        break;
      }
      offset = next;
      continue;
    }

    const nc = parsed.nextCursor;
    const hasCursor =
      nc &&
      typeof nc.lastAt === "string" &&
      nc.lastAt.length > 0 &&
      typeof nc.id === "string" &&
      nc.id.length > 0;

    if (parsed.partial === true) {
      if (hasCursor) {
        cursorLastAt = nc!.lastAt!;
        cursorId = nc!.id!;
      } else {
        cursorLastAt = null;
        cursorId = null;
      }
      continue;
    }

    if (hasCursor) {
      cursorLastAt = nc!.lastAt!;
      cursorId = nc!.id!;
    } else {
      console.error(
        `Stopped (${batch} invocation(s)): missing nextCursor with partial=false.`,
      );
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
