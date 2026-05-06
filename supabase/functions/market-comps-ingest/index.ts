import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { ebayClientCredentialsToken } from "../_shared/listing/ebay_market.ts";
import {
  ebayCompSearchQuery,
  MARKET_COMP_FINISHES,
  type PokemonCardCompSource,
} from "../_shared/listing/market_comps.ts";
import { ingestOneCardMarketComps } from "../_shared/listing/market_comps_ingest_card.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import type { MarketCardType } from "../_shared/listing/rss_market.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function authOk(req: Request): Promise<boolean> {
  const cron =
    Deno.env.get("LISTING_CRON_SECRET") ??
      Deno.env.get("MARKET_COMPS_CRON_SECRET");
  const secretHeader = req.headers.get("x-cron-secret");
  if (cron && secretHeader === cron) return true;

  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const bearer = auth.slice(7);
  if (cron && bearer === cron) return true;

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabaseUser = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user }, error } = await supabaseUser.auth.getUser();
  return !error && !!user;
}

function ebayAppCredentials(): { appId: string; certId: string } | null {
  const appId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  const certId =
    Deno.env.get("EBAY_CERT_ID") ?? Deno.env.get("EBAY_CLIENT_SECRET");
  if (!appId?.trim() || !certId?.trim()) return null;
  return { appId: appId.trim(), certId: certId.trim() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!(await authOk(req))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: {
    offset?: number;
    cursorLastAt?: string | null;
    cursorId?: string | null;
    /** `stale` = keyset by last comp time (default). `id` = legacy offset pagination by id. */
    order?: "stale" | "id";
  } = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t) as typeof body;
  } catch {
    body = {};
  }

  const orderMode =
    body.order ??
      (Deno.env.get("MARKET_COMPS_ORDER")?.trim().toLowerCase() === "id"
        ? "id"
        : "stale");

  const creds = ebayAppCredentials();
  if (!creds) {
    return json(
      { error: "Missing EBAY_APP_ID and EBAY_CERT_ID (or EBAY_CLIENT_SECRET)" },
      500,
    );
  }

  const admin = serviceClient();
  let token: string;
  try {
    token = await ebayClientCredentialsToken(creds.appId, creds.certId);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }

  /** Smaller batches + caps reduce Edge WORKER_LIMIT (CPU time). Inner loop does 1+ DB round-trips per Browse listing. */
  const rawBatch = Number(Deno.env.get("MARKET_COMPS_BATCH_SIZE") ?? "1");
  const batchSize = Math.min(
    20,
    Math.max(1, Number.isFinite(rawBatch) ? rawBatch : 1),
  );
  const envOffset = Math.max(
    0,
    Number(Deno.env.get("MARKET_COMPS_OFFSET") ?? "0"),
  );
  const offset = Math.max(
    0,
    Number.isFinite(body.offset) ? Math.floor(body.offset!) : envOffset,
  );

  /** Keyset cursor for stale-first mode (replay on partial). */
  const requestCursorLastAt =
    typeof body.cursorLastAt === "string" && body.cursorLastAt.trim() !== ""
      ? body.cursorLastAt.trim()
      : null;
  const requestCursorId =
    typeof body.cursorId === "string" && body.cursorId.trim() !== ""
      ? body.cursorId.trim()
      : null;
  const rawMaxSearches = Number(Deno.env.get("MARKET_COMPS_MAX_SEARCHES") ?? "3");
  const maxSearches = Math.min(
    200,
    Math.max(
      3,
      Number.isFinite(rawMaxSearches) ? rawMaxSearches : 3,
    ),
  );
  const rawBrowse = Number(Deno.env.get("MARKET_COMPS_BROWSE_LIMIT") ?? "10");
  const browseLimit = Math.min(
    50,
    Math.max(1, Number.isFinite(rawBrowse) ? rawBrowse : 10),
  );
  const rawMaxListings = Number(
    Deno.env.get("MARKET_COMPS_MAX_LISTINGS_PER_SEARCH") ?? "3",
  );
  const maxListingsPerSearch = Math.min(
    browseLimit,
    Math.max(1, Number.isFinite(rawMaxListings) ? rawMaxListings : 5),
  );
  /** Space Browse calls to reduce eBay API errorId 2001 / "Too many requests" (0 = no delay). */
  const delayMs = Math.max(
    0,
    Number(Deno.env.get("MARKET_COMPS_SEARCH_DELAY_MS") ?? "1500"),
  );

  let pokemonRows: Record<string, unknown>[] | null = null;
  let pErr: { message: string } | null = null;
  /** Last row sort_ts in stale mode (for nextCursor). */
  let lastSortTs: string | null = null;
  let lastRowId: string | null = null;

  if (orderMode === "stale") {
    const { data, error } = await admin.rpc("market_comps_next_cards", {
      p_cursor_last_at: requestCursorLastAt,
      p_cursor_id: requestCursorId,
      p_limit: batchSize,
    });
    pErr = error;
    const rows = (data ?? []) as Array<{
      id: string;
      name: string | null;
      card_set: string | null;
      card_number: string | null;
      sort_ts?: string;
    }>;
    pokemonRows = rows.map((r) => ({
      id: r.id,
      name: r.name,
      card_set: r.card_set,
      card_number: r.card_number,
    }));
    const last = rows[rows.length - 1];
    if (last) {
      lastSortTs = last.sort_ts != null ? String(last.sort_ts) : null;
      lastRowId = last.id;
    }
  } else {
    const r = await admin
      .from("pokemon_card_images")
      .select("id, name, card_set, card_number")
      .order("id", { ascending: true })
      .range(offset, offset + batchSize - 1);
    pErr = r.error;
    pokemonRows = r.data;
  }

  if (pErr) {
    return json({ error: pErr.message }, 500);
  }

  const cards = (pokemonRows ?? []) as PokemonCardCompSource[];
  const tierByCard = new Map<string, string>();
  if (cards.length > 0) {
    const { data: tierRows, error: tierErr } = await admin
      .from("pokemon_card_market_refresh")
      .select("pokemon_card_image_id, refresh_tier")
      .in(
        "pokemon_card_image_id",
        cards.map((c) => c.id),
      );
    if (tierErr) {
      return json({ error: tierErr.message }, 500);
    }
    for (const t of tierRows ?? []) {
      if (t.pokemon_card_image_id) {
        tierByCard.set(t.pokemon_card_image_id, t.refresh_tier);
      }
    }
  }
  let searches = 0;
  let listingsProcessed = 0;
  let inserts = 0;
  let updates = 0;
  const errors: string[] = [];
  let cardsProcessed = 0;
  let partial = false;

  for (const card of cards) {
    let cardSearchCount = 0;
    for (const cardType of MARKET_COMP_FINISHES) {
      const q = ebayCompSearchQuery(card, cardType as MarketCardType);
      if (q) cardSearchCount++;
    }
    if (cardSearchCount > maxSearches) {
      return json(
        {
          error:
            `MARKET_COMPS_MAX_SEARCHES (${maxSearches}) must be >= searches per card (${cardSearchCount})`,
        },
        400,
      );
    }
    if (searches + cardSearchCount > maxSearches) {
      partial = true;
      break;
    }

    const tr = tierByCard.get(card.id) ?? "normal";
    const one = await ingestOneCardMarketComps(admin, token, card, {
      browseLimit,
      maxListingsPerSearch,
      delayMs,
      recordActiveObservations: true,
      refreshTier: tr,
    });
    searches += one.searches;
    listingsProcessed += one.listingsProcessed;
    inserts += one.inserts;
    updates += one.updates;
    errors.push(...one.errors);

    cardsProcessed++;
  }

  const nextOffset = partial
    ? offset + cardsProcessed
    : offset + cards.length;
  const completedIdMode =
    !partial &&
    (cards.length === 0 || cards.length < batchSize);

  /** Stale mode: keyset cursor; never advance offset. */
  let completedStale = false;
  let nextCursor: { lastAt: string; id: string } | null = null;
  if (orderMode === "stale") {
    if (partial) {
      nextCursor =
        requestCursorLastAt && requestCursorId
          ? { lastAt: requestCursorLastAt, id: requestCursorId }
          : null;
    } else if (cards.length > 0 && lastSortTs && lastRowId) {
      nextCursor = { lastAt: lastSortTs, id: lastRowId };
    }
    completedStale =
      !partial &&
      (cards.length === 0 || cards.length < batchSize);
  }

  const completed =
    orderMode === "stale" ? completedStale : completedIdMode;

  return json({
    ok: true,
    order: orderMode,
    offset,
    nextOffset: orderMode === "id" ? nextOffset : undefined,
    nextCursor:
      orderMode === "stale" ? (completed ? null : nextCursor) : undefined,
    requestCursor:
      orderMode === "stale" && requestCursorLastAt && requestCursorId
        ? { lastAt: requestCursorLastAt, id: requestCursorId }
        : undefined,
    completed,
    partial,
    maxSearches,
    batchSize,
    browseLimit,
    maxListingsPerSearch,
    pokemonCardsInBatch: cards.length,
    browseSearches: searches,
    listingsProcessed,
    inserts,
    updates,
    errors,
  });
});
