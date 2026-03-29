import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  ebayClientCredentialsToken,
  searchBrowseBinListings,
} from "../_shared/listing/ebay_market.ts";
import {
  canonicalMarketRssTitle,
  ebayCompSearchQuery,
  MARKET_COMP_FINISHES,
  type PokemonCardCompSource,
} from "../_shared/listing/market_comps.ts";
import { serviceClient } from "../_shared/listing/supabase_admin.ts";
import {
  appendShippingRing,
  appendUniquePriceRing,
  averagePriceCents,
  isSameMarketListingUrl,
  priceHistoryFromJson,
  shippingAverageFromHistory,
  shippingHistoryFromJson,
  shippingHistoryToJson,
  type MarketCardType,
} from "../_shared/listing/rss_market.ts";

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

type DbMarketRow = {
  id: string;
  listing_url: string | null;
  ebay_item_id: string | null;
  price_cents_history: unknown;
  shipping_history: unknown;
  average_price_cents: number | null;
  previous_average_price_cents: number | null;
  shipping_average_free: boolean;
  shipping_average_cents: number | null;
  listed_date: string | null;
  card_name: string | null;
};

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

  const batchSize = Math.min(
    200,
    Math.max(1, Number(Deno.env.get("MARKET_COMPS_BATCH_SIZE") ?? "15")),
  );
  const offset = Math.max(
    0,
    Number(Deno.env.get("MARKET_COMPS_OFFSET") ?? "0"),
  );
  const browseLimit = Math.min(
    50,
    Math.max(1, Number(Deno.env.get("MARKET_COMPS_BROWSE_LIMIT") ?? "25")),
  );
  const delayMs = Math.max(
    0,
    Number(Deno.env.get("MARKET_COMPS_SEARCH_DELAY_MS") ?? "150"),
  );

  const { data: pokemonRows, error: pErr } = await admin
    .from("pokemon_card_images")
    .select("id, name, card_set, card_number")
    .order("id", { ascending: true })
    .range(offset, offset + batchSize - 1);

  if (pErr) {
    return json({ error: pErr.message }, 500);
  }

  const cards = (pokemonRows ?? []) as PokemonCardCompSource[];
  let searches = 0;
  let listingsProcessed = 0;
  let inserts = 0;
  let updates = 0;
  const errors: string[] = [];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const card of cards) {
    for (const cardType of MARKET_COMP_FINISHES) {
      const q = ebayCompSearchQuery(card, cardType as MarketCardType);
      if (!q) continue;

      if (delayMs > 0 && searches > 0) await sleep(delayMs);
      searches++;

      let browse: Awaited<ReturnType<typeof searchBrowseBinListings>>;
      try {
        browse = await searchBrowseBinListings(token, q, browseLimit);
      } catch (e) {
        errors.push(`${card.id} ${cardType}: ${(e as Error).message}`);
        continue;
      }

      if (browse.error) {
        errors.push(
          `${card.id} ${cardType}: browse ${browse.status}: ${browse.error}`,
        );
        continue;
      }

      const title = canonicalMarketRssTitle(card, cardType as MarketCardType);
      if (!title) continue;

      const cardName = (card.name ?? "").trim();
      const cardNumber = (card.card_number ?? "").trim();
      const cardSet = (card.card_set ?? "").trim();

      let { data: existing, error: findErr } = await admin
        .from("market_rss_cards")
        .select(
          "id, listing_url, ebay_item_id, price_cents_history, shipping_history, average_price_cents, previous_average_price_cents, shipping_average_free, shipping_average_cents, listed_date, card_name",
        )
        .eq("pokemon_card_image_id", card.id)
        .eq("card_type", cardType)
        .maybeSingle();

      if (findErr) {
        errors.push(`${card.id} ${cardType} find: ${findErr.message}`);
        continue;
      }

      let row: DbMarketRow | null = existing as DbMarketRow | null;

      for (const listing of browse.items) {
        listingsProcessed++;
        const nowIso = new Date().toISOString();
        const price = listing.priceCents;
        const ship = listing.shipping;

        if (!row) {
          const prices = appendUniquePriceRing([], price);
          const shippingH = appendShippingRing([], ship);
          const shipAvg = shippingAverageFromHistory(shippingH);

          const { data: ins, error: insErr } = await admin
            .from("market_rss_cards")
            .insert({
              rss_title: title,
              card_name: cardName || null,
              card_number: cardNumber || null,
              card_set: cardSet || null,
              pokemon_card_image_id: card.id,
              card_type: cardType,
              listed_date: listing.listedDate,
              price_cents_history: prices,
              shipping_history: shippingHistoryToJson(shippingH),
              shipping_average_free: shipAvg.free,
              shipping_average_cents: shipAvg.free ? null : shipAvg.cents,
              average_price_cents: averagePriceCents(prices),
              previous_average_price_cents: null,
              quantity: 1,
              ebay_item_id: listing.itemId,
              listing_url: listing.itemWebUrl,
              last_ingest_at: nowIso,
            })
            .select(
              "id, listing_url, ebay_item_id, price_cents_history, shipping_history, average_price_cents, previous_average_price_cents, shipping_average_free, shipping_average_cents, listed_date, card_name",
            )
            .single();

          if (insErr) {
            errors.push(`${card.id} ${cardType} insert: ${insErr.message}`);
            break;
          }
          row = ins as DbMarketRow;
          inserts++;
          continue;
        }

        const sameListing = isSameMarketListingUrl(
          {
            listing_url: row.listing_url,
            ebay_item_id: row.ebay_item_id,
          },
          listing.itemWebUrl,
          listing.itemId,
        );

        if (sameListing) {
          const { error: upErr } = await admin.from("market_rss_cards").update({
            updated_at: nowIso,
            last_ingest_at: nowIso,
            listing_url: listing.itemWebUrl,
            ebay_item_id: listing.itemId,
            quantity: 1,
            listed_date: listing.listedDate ?? row.listed_date,
          }).eq("id", row.id);
          if (upErr) {
            errors.push(`${row.id} same-listing: ${upErr.message}`);
          } else {
            updates++;
            row = {
              ...row,
              listing_url: listing.itemWebUrl,
              ebay_item_id: listing.itemId,
              listed_date: listing.listedDate ?? row.listed_date,
            };
          }
          continue;
        }

        const prevAvg = row.average_price_cents;
        const prices = appendUniquePriceRing(
          priceHistoryFromJson(row.price_cents_history),
          price,
        );
        const shippingH = appendShippingRing(
          shippingHistoryFromJson(row.shipping_history),
          ship,
        );
        const avg = averagePriceCents(prices);
        const shipAvg = shippingAverageFromHistory(shippingH);

        const { error: upErr } = await admin.from("market_rss_cards").update({
          updated_at: nowIso,
          last_ingest_at: nowIso,
          listing_url: listing.itemWebUrl,
          ebay_item_id: listing.itemId,
          card_name: cardName || row.card_name,
          quantity: 1,
          listed_date: listing.listedDate ?? row.listed_date,
          price_cents_history: prices,
          shipping_history: shippingHistoryToJson(shippingH),
          shipping_average_free: shipAvg.free,
          shipping_average_cents: shipAvg.free ? null : shipAvg.cents,
          previous_average_price_cents: prevAvg ?? null,
          average_price_cents: avg,
        }).eq("id", row.id);

        if (upErr) {
          errors.push(`${row.id} update: ${upErr.message}`);
        } else {
          updates++;
          row = {
            ...row,
            listing_url: listing.itemWebUrl,
            ebay_item_id: listing.itemId,
            price_cents_history: prices,
            shipping_history: shippingHistoryToJson(shippingH),
            average_price_cents: avg,
            previous_average_price_cents: prevAvg ?? null,
            shipping_average_free: shipAvg.free,
            shipping_average_cents: shipAvg.free ? null : shipAvg.cents,
            listed_date: listing.listedDate ?? row.listed_date,
            card_name: cardName || row.card_name,
          };
        }
      }
    }
  }

  return json({
    ok: true,
    offset,
    batchSize,
    pokemonCardsInBatch: cards.length,
    browseSearches: searches,
    listingsProcessed,
    inserts,
    updates,
    errors,
  });
});
