import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { fetchSoldCompsAverageCents } from "../_shared/listing/ebay_market.ts";
import {
  canonicalMarketRssTitle,
  ebayCompSearchQuery,
  MARKET_COMP_FINISHES,
  type PokemonCardCompSource,
} from "../_shared/listing/market_comps.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import { nextSoldRefreshAtIso } from "../_shared/listing/market_refresh.ts";
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
  let rowsUpserted = 0;
  const errors: string[] = [];
  let cardsProcessed = 0;
  let partial = false;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const card of cards) {
    const soldSnapBatch: {
      pokemon_card_image_id: string;
      card_type: string;
      market_sold_comp_id: string | null;
      search_query: string;
      average_price_cents: number | null;
      sample_size: number;
      ingested_at: string;
    }[] = [];
    let cardSearchCount = 0;
    for (const cardType of MARKET_COMP_FINISHES) {
      const q = ebayCompSearchQuery(card, cardType as MarketCardType);
      if (q) cardSearchCount++;
    }
    if (cardSearchCount === 0) {
      const tr = tierByCard.get(card.id) ?? "normal";
      const nowIso = new Date().toISOString();
      const { error: refErr } = await admin
        .from("pokemon_card_market_refresh")
        .upsert(
          {
            pokemon_card_image_id: card.id,
            last_sold_ingest_at: nowIso,
            next_sold_refresh_at: nextSoldRefreshAtIso(tr),
            updated_at: nowIso,
          },
          { onConflict: "pokemon_card_image_id" },
        );
      if (refErr) {
        errors.push(`pokemon_card_market_refresh (sold): ${refErr.message}`);
      }
      cardsProcessed++;
      continue;
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
    if (searches + cardSearchCount > maxSearches) {
      partial = true;
      break;
    }

    for (const cardType of MARKET_COMP_FINISHES) {
      const q = ebayCompSearchQuery(card, cardType as MarketCardType);
      if (!q) continue;

      if (delayMs > 0 && searches > 0) await sleep(delayMs);
      searches++;

      const title = canonicalMarketRssTitle(card, cardType as MarketCardType);
      if (!title) continue;

      const cardName = (card.name ?? "").trim();
      const cardNumber = (card.card_number ?? "").trim();
      const cardSet = (card.card_set ?? "").trim();

      let sold: Awaited<ReturnType<typeof fetchSoldCompsAverageCents>>;
      try {
        sold = await fetchSoldCompsAverageCents(appId, q, findingLimit);
      } catch (e) {
        errors.push(`${card.id} ${cardType}: ${(e as Error).message}`);
        continue;
      }

      const nowIso = new Date().toISOString();
      const { data: soldRow, error: upErr } = await admin
        .from("market_sold_comps")
        .upsert(
          {
            rss_title: title,
            card_name: cardName || null,
            card_number: cardNumber || null,
            card_set: cardSet || null,
            pokemon_card_image_id: card.id,
            card_type: cardType,
            average_price_cents: sold.averageCents,
            sample_size: sold.sampleSize,
            updated_at: nowIso,
          },
          { onConflict: "pokemon_card_image_id,card_type" },
        )
        .select("id")
        .single();

      if (upErr) {
        errors.push(`${card.id} ${cardType} upsert: ${upErr.message}`);
      } else {
        rowsUpserted++;
        soldSnapBatch.push({
          pokemon_card_image_id: card.id,
          card_type: String(cardType),
          market_sold_comp_id: soldRow?.id ?? null,
          search_query: q,
          average_price_cents: sold.averageCents,
          sample_size: sold.sampleSize,
          ingested_at: nowIso,
        });
      }
    }
    if (soldSnapBatch.length > 0) {
      const { error: snapErr } = await admin
        .from("market_sold_comp_snapshots")
        .insert(soldSnapBatch);
      if (snapErr) {
        errors.push(`market_sold_comp_snapshots: ${snapErr.message}`);
      }
    }
    const tr = tierByCard.get(card.id) ?? "normal";
    const { error: refErr } = await admin
      .from("pokemon_card_market_refresh")
      .upsert(
        {
          pokemon_card_image_id: card.id,
          last_sold_ingest_at: new Date().toISOString(),
          next_sold_refresh_at: nextSoldRefreshAtIso(tr),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "pokemon_card_image_id" },
      );
    if (refErr) {
      errors.push(`pokemon_card_market_refresh (sold): ${refErr.message}`);
    }
    cardsProcessed++;
  }

  const nextOffset = partial
    ? offset + cardsProcessed
    : offset + cards.length;
  const completedIdMode =
    !partial &&
    (cards.length === 0 || cards.length < batchSize);

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
    findingLimit,
    pokemonCardsInBatch: cards.length,
    soldSearches: searches,
    rowsUpserted,
    errors,
  });
});
