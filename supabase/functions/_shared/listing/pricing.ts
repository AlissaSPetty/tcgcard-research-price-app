import type { CompResult, LpPriceSource, PricingConfig } from "./types.ts";

export interface EbayCompFetch {
  (query: string): Promise<CompResult>;
}

export interface TcgPriceFetch {
  (query: string): Promise<{ medianCents: number | null; sampleSize: number } | null>;
}

/**
 * Hybrid: primary eBay comps; if sample thin, blend with TCG median when available.
 */
export async function hybridPriceCents(
  titleHint: string,
  config: PricingConfig,
  fetchEbay: EbayCompFetch,
  fetchTcg: TcgPriceFetch,
): Promise<{
  cents: number | null;
  source: LpPriceSource;
  confidence: number;
  comps: CompResult;
  tcgMedian: number | null;
}> {
  const comps = await fetchEbay(titleHint);
  let tcgMedian: number | null = null;
  let tcgN = 0;
  if (config.tcgEnabled) {
    const t = await fetchTcg(titleHint);
    if (t) {
      tcgMedian = t.medianCents;
      tcgN = t.sampleSize;
    }
  }

  const ebayMedian =
    comps.weeklyMedianCents ?? comps.dailyMedianCents ?? null;
  const ebayOk = comps.sampleSize >= config.ebaySampleMin && ebayMedian != null;

  if (ebayOk && tcgMedian != null) {
    const cents = Math.max(ebayMedian, tcgMedian);
    return {
      cents,
      source: "blended",
      confidence: Math.min(1, comps.sampleSize / 10),
      comps,
      tcgMedian,
    };
  }

  if (ebayOk && ebayMedian != null) {
    return {
      cents: ebayMedian,
      source: "ebay",
      confidence: Math.min(1, comps.sampleSize / 10),
      comps,
      tcgMedian,
    };
  }

  if (tcgMedian != null && config.tcgEnabled) {
    return {
      cents: tcgMedian,
      source: "tcg",
      confidence: tcgN > 0 ? 0.6 : 0.3,
      comps,
      tcgMedian,
    };
  }

  if (ebayMedian != null) {
    return {
      cents: ebayMedian,
      source: "ebay",
      confidence: 0.3,
      comps,
      tcgMedian,
    };
  }

  return {
    cents: null,
    source: "ebay",
    confidence: 0,
    comps,
    tcgMedian,
  };
}
