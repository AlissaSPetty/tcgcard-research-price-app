import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  ebayCompSearchQuery,
  MARKET_COMP_FINISHES,
  type PokemonCardCompSource,
} from "../_shared/listing/market_comps.ts";
import {
  cardHasTcgPricingScope,
  tcgplayerActiveFinishes,
} from "../_shared/listing/tcg_finish_scope.ts";
import { ingestOneCardSoldComps } from "../_shared/listing/market_sold_comps_ingest_card.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import type { MarketCardType } from "../_shared/listing/rss_market.ts";
import { maintenanceGate } from "../_shared/maintenance.ts";

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

async function attachTcgPricing(
  admin: ReturnType<typeof serviceClient>,
  cards: PokemonCardCompSource[],
): Promise<PokemonCardCompSource[]> {
  if (cards.length === 0) return cards;
  const { data, error } = await admin
    .from("pokemon_card_images")
    .select("id, tcgplayer_prices_by_finish, tcgplayer_price_cents")
    .in("id", cards.map((c) => c.id));
  if (error || !data?.length) return cards;
  type TcgRow = {
    id: string;
    tcgplayer_prices_by_finish: unknown;
    tcgplayer_price_cents: number | null;
  };
  const m = new Map((data as TcgRow[]).map((r) => [r.id, r]));
  return cards.map((c) => {
    const row = m.get(c.id);
    if (!row) return c;
    return {
      ...c,
      tcgplayer_prices_by_finish: row.tcgplayer_prices_by_finish,
      tcgplayer_price_cents: row.tcgplayer_price_cents,
    };
  });
}

async function authOk(req: Request): Promise<boolean> {
  const cron =
    Deno.env.get("LISTING_CRON_SECRET") ??
      Deno.env.get("MARKET_SOLD_COMPS_CRON_SECRET");
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

/** Finding API uses App ID only (not OAuth client-credentials). */
function ebayAppIdOnly(): string | null {
  const appId = Deno.env.get("EBAY_APP_ID") ?? Deno.env.get("EBAY_CLIENT_ID");
  if (!appId?.trim()) return null;
  return appId.trim();
}

Deno.serve(async (req) => {
  const maintenance = maintenanceGate(req, cors);
  if (maintenance) return maintenance;

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
      (Deno.env.get("MARKET_SOLD_COMPS_ORDER")?.trim().toLowerCase() === "id"
        ? "id"
        : "stale");

  const appId = ebayAppIdOnly();
  if (!appId) {
    return json(
      { error: "Missing EBAY_APP_ID (or EBAY_CLIENT_ID) for Finding API" },
      500,
    );
  }

  const admin = serviceClient();

  const rawBatch = Number(Deno.env.get("MARKET_SOLD_COMPS_BATCH_SIZE") ?? "1");
  const batchSize = Math.min(
    20,
    Math.max(1, Number.isFinite(rawBatch) ? rawBatch : 1),
  );
  const envOffset = Math.max(
    0,
    Number(Deno.env.get("MARKET_SOLD_COMPS_OFFSET") ?? "0"),
  );
  const offset = Math.max(
    0,
    Number.isFinite(body.offset) ? Math.floor(body.offset!) : envOffset,
  );

  const requestCursorLastAt =
    typeof body.cursorLastAt === "string" && body.cursorLastAt.trim() !== ""
      ? body.cursorLastAt.trim()
      : null;
  const requestCursorId =
    typeof body.cursorId === "string" && body.cursorId.trim() !== ""
      ? body.cursorId.trim()
      : null;

  const rawMaxSearches = Number(
    Deno.env.get("MARKET_SOLD_COMPS_MAX_SEARCHES") ?? "3",
  );
  const maxSearches = Math.min(
    200,
    Math.max(
      3,
      Number.isFinite(rawMaxSearches) ? rawMaxSearches : 3,
    ),
  );

  const rawFinding = Number(
    Deno.env.get("MARKET_SOLD_COMPS_FINDING_LIMIT") ?? "100",
  );
  const findingLimit = Math.min(
    100,
    Math.max(1, Number.isFinite(rawFinding) ? rawFinding : 100),
  );

  const delayMs = Math.max(
    0,
    Number(Deno.env.get("MARKET_SOLD_COMPS_SEARCH_DELAY_MS") ?? "0"),
  );

  let pokemonRows: Record<string, unknown>[] | null = null;
  let pErr: { message: string } | null = null;
  let lastSortTs: string | null = null;
  let lastRowId: string | null = null;

  if (orderMode === "stale") {
    const { data, error } = await admin.rpc("market_sold_comps_next_cards", {
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
  const cardsWithTcg = await attachTcgPricing(admin, cards);
  const tierByCard = new Map<string, string>();
  if (cardsWithTcg.length > 0) {
    const { data: tierRows, error: tierErr } = await admin
      .from("pokemon_card_market_refresh")
      .select("pokemon_card_image_id, refresh_tier")
      .in(
        "pokemon_card_image_id",
        cardsWithTcg.map((c) => c.id),
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
  let rowsUpserted = 0;
  const errors: string[] = [];
  let cardsProcessed = 0;
  let partial = false;

  for (const card of cardsWithTcg) {
    const activeFinishes = cardHasTcgPricingScope(card)
      ? tcgplayerActiveFinishes(card)
      : [...MARKET_COMP_FINISHES];
    let cardSearchCount = 0;
    for (const cardType of activeFinishes) {
      const q = ebayCompSearchQuery(card, cardType as MarketCardType);
      if (q) cardSearchCount++;
    }
    if (cardSearchCount > maxSearches) {
      return json(
        {
          error:
            `MARKET_SOLD_COMPS_MAX_SEARCHES (${maxSearches}) must be >= searches per card (${cardSearchCount})`,
        },
        400,
      );
    }
    // Reserve cross-card search budget before starting the card's loop so we
    // never exceed MARKET_SOLD_COMPS_MAX_SEARCHES across cards in this batch.
    if (cardSearchCount > 0 && searches + cardSearchCount > maxSearches) {
      partial = true;
      break;
    }

    const tier = tierByCard.get(card.id) ?? "normal";
    const result = await ingestOneCardSoldComps(admin, appId, card, {
      findingLimit,
      delayMs,
      recordSnapshots: true,
      refreshTier: tier,
    });

    searches += result.searches;
    rowsUpserted += result.rowsUpserted;
    if (result.errors.length > 0) errors.push(...result.errors);
    cardsProcessed++;
  }

  const nextOffset = partial
    ? offset + cardsProcessed
    : offset + cardsWithTcg.length;
  const completedIdMode =
    !partial &&
    (cardsWithTcg.length === 0 || cardsWithTcg.length < batchSize);

  let completedStale = false;
  let nextCursor: { lastAt: string; id: string } | null = null;
  if (orderMode === "stale") {
    if (partial) {
      nextCursor =
        requestCursorLastAt && requestCursorId
          ? { lastAt: requestCursorLastAt, id: requestCursorId }
          : null;
    } else if (cardsWithTcg.length > 0 && lastSortTs && lastRowId) {
      nextCursor = { lastAt: lastSortTs, id: lastRowId };
    }
    completedStale =
      !partial &&
      (cardsWithTcg.length === 0 || cardsWithTcg.length < batchSize);
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
    findingLimit,
    pokemonCardsInBatch: cardsWithTcg.length,
    soldSearches: searches,
    rowsUpserted,
    errors,
  });
});
