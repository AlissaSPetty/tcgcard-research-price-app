/**
 * Per-card eBay Finding (sold) → market_sold_comps ingest (shared by batch
 * `market-sold-comps-ingest` and on-demand `market-sold-comps-card-fetch`).
 */
import { fetchSoldCompsAverageCents } from "./ebay_market.ts";
import {
  canonicalMarketRssTitle,
  ebayCompSearchQuery,
  type PokemonCardCompSource,
} from "./market_comps.ts";
import {
  cardHasTcgPricingScope,
  marketCompFinishesExcludedByTcg,
  marketCompFinishesFallback,
  tcgplayerActiveFinishes,
} from "./tcg_finish_scope.ts";
import { nextSoldRefreshAtIso } from "./market_refresh.ts";
import type { MarketCardType } from "./rss_market.ts";
import { serviceClient } from "./supabase_admin.ts";

type ServiceAdmin = ReturnType<typeof serviceClient>;

export type IngestOneCardSoldOptions = {
  findingLimit: number;
  /** Space Finding calls to reduce eBay throttling (0 = no delay). */
  delayMs: number;
  /** When false, skip `market_sold_comp_snapshots` inserts (on-demand detail fetches). */
  recordSnapshots: boolean;
  /** From `pokemon_card_market_refresh.refresh_tier` for this card. */
  refreshTier: string;
};

export type IngestOneCardSoldResult = {
  searches: number;
  rowsUpserted: number;
  errors: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run Finding sold-comps ingest for a single catalog card (all finishes with valid queries).
 * Always upserts the per-card refresh row so future cron passes know we just touched this card.
 */
export async function ingestOneCardSoldComps(
  admin: ServiceAdmin,
  appId: string,
  card: PokemonCardCompSource,
  options: IngestOneCardSoldOptions,
): Promise<IngestOneCardSoldResult> {
  const { findingLimit, delayMs, recordSnapshots, refreshTier } = options;

  let searches = 0;
  let rowsUpserted = 0;
  const errors: string[] = [];

  const activeFinishes = cardHasTcgPricingScope(card)
    ? tcgplayerActiveFinishes(card)
    : marketCompFinishesFallback();
  const excludedSold = cardHasTcgPricingScope(card)
    ? marketCompFinishesExcludedByTcg(activeFinishes)
    : [];
  if (excludedSold.length > 0) {
    const { error: delS } = await admin
      .from("market_sold_comps")
      .delete()
      .eq("pokemon_card_image_id", card.id)
      .in("card_type", excludedSold);
    if (delS) errors.push(`cleanup market_sold_comps: ${delS.message}`);
  }

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
  for (const cardType of activeFinishes) {
    const q = ebayCompSearchQuery(card, cardType as MarketCardType);
    if (q) cardSearchCount++;
  }

  if (cardSearchCount === 0) {
    const nowIso = new Date().toISOString();
    const { error: refErr } = await admin
      .from("pokemon_card_market_refresh")
      .upsert(
        {
          pokemon_card_image_id: card.id,
          last_sold_ingest_at: nowIso,
          next_sold_refresh_at: nextSoldRefreshAtIso(refreshTier),
          updated_at: nowIso,
        },
        { onConflict: "pokemon_card_image_id" },
      );
    if (refErr) {
      errors.push(`pokemon_card_market_refresh (sold): ${refErr.message}`);
    }
    return { searches, rowsUpserted, errors };
  }

  for (const cardType of activeFinishes) {
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
      if (recordSnapshots) {
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
  }

  if (recordSnapshots && soldSnapBatch.length > 0) {
    const { error: snapErr } = await admin
      .from("market_sold_comp_snapshots")
      .insert(soldSnapBatch);
    if (snapErr) {
      errors.push(`market_sold_comp_snapshots: ${snapErr.message}`);
    }
  }

  const nowIso = new Date().toISOString();
  const { error: refErr } = await admin
    .from("pokemon_card_market_refresh")
    .upsert(
      {
        pokemon_card_image_id: card.id,
        last_sold_ingest_at: nowIso,
        next_sold_refresh_at: nextSoldRefreshAtIso(refreshTier),
        updated_at: nowIso,
      },
      { onConflict: "pokemon_card_image_id" },
    );
  if (refErr) {
    errors.push(`pokemon_card_market_refresh (sold): ${refErr.message}`);
  }

  return { searches, rowsUpserted, errors };
}
