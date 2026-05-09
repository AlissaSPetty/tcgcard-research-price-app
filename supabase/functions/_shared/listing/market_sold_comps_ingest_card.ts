/**
 * Per-card eBay Finding (sold) → market_sold_comps ingest (shared by batch
 * `market-sold-comps-ingest` and on-demand `market-sold-comps-card-fetch`).
 */
import {
  fetchMarketCompsBrowse,
  fetchSoldCompsAverageCents,
} from "./ebay_market.ts";
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
  /**
   * Browse OAuth token (same app + cert as BIN comps). When Finding fails with a
   * transport/rate-limit style error, use active BIN listings as a price estimate.
   * Used by `market-sold-comps-card-fetch` only; batch ingest omits this.
   */
  browseFallbackToken?: string;
};

/** Finding API diagnostics per finish (for debugging empty sold comps). */
export type SoldCompFindingDiag = {
  card_type: string;
  query_preview: string;
  sample_size: number;
  raw?: Record<string, unknown>;
  finding_attempt_raw?: Record<string, unknown>;
};

export type IngestOneCardSoldResult = {
  searches: number;
  rowsUpserted: number;
  errors: string[];
  findingDiagnostics?: SoldCompFindingDiag[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** When Finding did not yield a persistable row, Browse may still estimate from active BIN. */
function shouldTryFindingBrowseFallback(raw?: Record<string, unknown>): boolean {
  if (!raw) return false;
  const reason = String(raw.reason ?? "");
  if (reason === "no_ebay_app_id") return false;
  if (reason === "finding_api_price_parse_failed") return false;
  if (reason.startsWith("finding_api_ack_error")) return false;
  if (reason === "finding_api_no_items") return false;
  return (
    reason.startsWith("finding_api_http_error") ||
    /ratelimiter|10001|rate.?limit/i.test(reason) ||
    raw.diag_httpStatus === 500 ||
    raw.diag_httpStatus === 429
  );
}

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
  const { findingLimit, delayMs, recordSnapshots, refreshTier, browseFallbackToken } =
    options;

  let searches = 0;
  let rowsUpserted = 0;
  const errors: string[] = [];
  const findingDiagnostics: SoldCompFindingDiag[] = [];

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
    return { searches, rowsUpserted, errors, findingDiagnostics };
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

    let resolved = sold;
    const browseTok = browseFallbackToken?.trim();
    if (
      sold.raw?.ingestSoldRow !== true &&
      browseTok &&
      shouldTryFindingBrowseFallback(sold.raw)
    ) {
      try {
        const bin = await fetchMarketCompsBrowse(
          browseTok,
          q,
          Math.min(25, findingLimit),
        );
        if (bin.sampleSize > 0 && bin.averageCents != null) {
          const br = bin.raw && typeof bin.raw === "object" && !Array.isArray(bin.raw)
            ? (bin.raw as Record<string, unknown>)
            : {};
          resolved = {
            averageCents: bin.averageCents,
            sampleSize: bin.sampleSize,
            raw: {
              ...br,
              ingestSoldRow: true,
              source: "browse_bin_fallback",
              findingFallbackReason: sold.raw?.reason,
            },
          };
        }
      } catch (e) {
        errors.push(`${card.id} ${cardType} browse fallback: ${(e as Error).message}`);
      }
    }

    findingDiagnostics.push({
      card_type: String(cardType),
      query_preview: q.slice(0, 120),
      sample_size: resolved.sampleSize,
      raw: resolved.raw,
      finding_attempt_raw: sold.raw,
    });

    if (resolved.raw?.ingestSoldRow !== true) {
      errors.push(
        `${card.id} ${cardType}: ${String(resolved.raw?.reason ?? "finding_api_failed")}`,
      );
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
          average_price_cents: resolved.averageCents,
          sample_size: resolved.sampleSize,
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
          average_price_cents: resolved.averageCents,
          sample_size: resolved.sampleSize,
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

  // Do not advance sold refresh cursor when every Finding call failed (e.g. rate limit);
  // avoids cooldown treating a failed run as a successful ingest.
  if (searches > 0 && rowsUpserted === 0) {
    return { searches, rowsUpserted, errors, findingDiagnostics };
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

  return { searches, rowsUpserted, errors, findingDiagnostics };
}
