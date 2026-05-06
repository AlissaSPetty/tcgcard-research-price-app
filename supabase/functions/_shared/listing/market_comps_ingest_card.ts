/**
 * Per-card eBay Browse → market_rss_cards ingest (shared by batch `market-comps-ingest`
 * and on-demand `market-comps-card-fetch`).
 */
import { searchBrowseBinListings } from "./ebay_market.ts";
import {
  canonicalMarketRssTitle,
  ebayCompSearchQuery,
  MARKET_COMP_FINISHES,
  type PokemonCardCompSource,
} from "./market_comps.ts";
import { nextActiveRefreshAtIso } from "./market_refresh.ts";
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
  type ShippingEntry,
} from "./rss_market.ts";
import { serviceClient } from "./supabase_admin.ts";

type ServiceAdmin = ReturnType<typeof serviceClient>;

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

function shippingEntryToJson(ship: ShippingEntry): Record<string, unknown> {
  if (ship === "free" || ship === "unknown") return { kind: ship };
  return { kind: "paid", cents: ship };
}

export type IngestOneCardOptions = {
  browseLimit: number;
  maxListingsPerSearch: number;
  /** Space Browse calls to reduce eBay throttling (0 = no delay). */
  delayMs: number;
  /** When false, skip `market_rss_active_observations` inserts (on-demand detail fetches). */
  recordActiveObservations: boolean;
  /** From `pokemon_card_market_refresh.refresh_tier` for this card. */
  refreshTier: string;
};

export type IngestOneCardResult = {
  searches: number;
  listingsProcessed: number;
  inserts: number;
  updates: number;
  errors: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run Browse BIN comp ingest for a single catalog card (all finishes with valid queries).
 */
export async function ingestOneCardMarketComps(
  admin: ServiceAdmin,
  token: string,
  card: PokemonCardCompSource,
  options: IngestOneCardOptions,
): Promise<IngestOneCardResult> {
  const {
    browseLimit,
    maxListingsPerSearch,
    delayMs,
    recordActiveObservations,
    refreshTier,
  } = options;

  let searches = 0;
  let listingsProcessed = 0;
  let inserts = 0;
  let updates = 0;
  const errors: string[] = [];

  const activeObsBatch: {
    pokemon_card_image_id: string;
    market_rss_card_id: string;
    card_type: string;
    ebay_item_id: string;
    listing_url: string;
    observed_at: string;
    price_cents: number;
    shipping: Record<string, unknown>;
  }[] = [];

  let cardSearchCount = 0;
  for (const cardType of MARKET_COMP_FINISHES) {
    const q = ebayCompSearchQuery(card, cardType as MarketCardType);
    if (q) cardSearchCount++;
  }

  if (cardSearchCount === 0) {
    const nowIso = new Date().toISOString();
    const { error: upRefErr } = await admin
      .from("pokemon_card_market_refresh")
      .upsert(
        {
          pokemon_card_image_id: card.id,
          last_active_ingest_at: nowIso,
          next_active_refresh_at: nextActiveRefreshAtIso(refreshTier),
          updated_at: nowIso,
        },
        { onConflict: "pokemon_card_image_id" },
      );
    if (upRefErr) {
      errors.push(`pokemon_card_market_refresh: ${upRefErr.message}`);
    }
    return { searches, listingsProcessed, inserts, updates, errors };
  }

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

    const items = browse.items.slice(0, maxListingsPerSearch);

    for (const listing of items) {
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
        if (recordActiveObservations) {
          activeObsBatch.push({
            pokemon_card_image_id: card.id,
            market_rss_card_id: row.id,
            card_type: String(cardType),
            ebay_item_id: listing.itemId,
            listing_url: listing.itemWebUrl,
            observed_at: nowIso,
            price_cents: price,
            shipping: shippingEntryToJson(ship),
          });
        }
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
          if (recordActiveObservations) {
            activeObsBatch.push({
              pokemon_card_image_id: card.id,
              market_rss_card_id: row.id,
              card_type: String(cardType),
              ebay_item_id: listing.itemId,
              listing_url: listing.itemWebUrl,
              observed_at: nowIso,
              price_cents: price,
              shipping: shippingEntryToJson(ship),
            });
          }
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
        if (recordActiveObservations) {
          activeObsBatch.push({
            pokemon_card_image_id: card.id,
            market_rss_card_id: row.id,
            card_type: String(cardType),
            ebay_item_id: listing.itemId,
            listing_url: listing.itemWebUrl,
            observed_at: nowIso,
            price_cents: price,
            shipping: shippingEntryToJson(ship),
          });
        }
      }
    }
  }

  if (recordActiveObservations && activeObsBatch.length > 0) {
    const { error: obsInsErr } = await admin
      .from("market_rss_active_observations")
      .insert(activeObsBatch);
    if (obsInsErr) {
      errors.push(`active observations insert: ${obsInsErr.message}`);
    }
  }

  const { error: upRefErr } = await admin
    .from("pokemon_card_market_refresh")
    .upsert(
      {
        pokemon_card_image_id: card.id,
        last_active_ingest_at: new Date().toISOString(),
        next_active_refresh_at: nextActiveRefreshAtIso(refreshTier),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "pokemon_card_image_id" },
    );
  if (upRefErr) {
    errors.push(`pokemon_card_market_refresh: ${upRefErr.message}`);
  }

  return { searches, listingsProcessed, inserts, updates, errors };
}
