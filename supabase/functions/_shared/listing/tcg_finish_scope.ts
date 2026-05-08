import type { MarketCardType } from "./rss_market.ts";
import type { PokemonCardCompSource } from "./market_comps.ts";
import { MARKET_COMP_FINISHES } from "./market_comps.ts";

/** Catalog finishes derived from tcgcsv `/prices` + legacy Normal aggregate. */
const ORDER: readonly MarketCardType[] = MARKET_COMP_FINISHES;

function parseTcgFinishPrices(v: unknown): {
  market_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  direct_cents: number | null;
} | null {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => {
    const x = o[k];
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  };
  return {
    market_cents: n("market_cents"),
    low_cents: n("low_cents"),
    high_cents: n("high_cents"),
    direct_cents: n("direct_cents"),
  };
}

const TRY_KEYS: Record<
  "Normal" | "Holo" | "Reverse Holo",
  string[]
> = {
  Normal: ["Normal", "normal"],
  Holo: ["Holofoil", "Holo", "holofoil"],
  "Reverse Holo": ["Reverse Holofoil", "Reverse Holo", "reverse holofoil"],
};

function finishHasTcgPrice(
  raw: Record<string, unknown> | null,
  finish: MarketCardType,
): boolean {
  const keys = TRY_KEYS[finish as keyof typeof TRY_KEYS];
  if (!keys) return false;
  for (const key of keys) {
    const d = parseTcgFinishPrices(raw?.[key]);
    if (
      d &&
      (d.market_cents != null ||
        d.low_cents != null ||
        d.high_cents != null ||
        d.direct_cents != null)
    ) {
      return true;
    }
  }
  return false;
}

function tcgPrimaryCentsFromDetail(
  d: NonNullable<ReturnType<typeof parseTcgFinishPrices>>,
): number | null {
  return d.market_cents ?? d.low_cents ?? d.direct_cents ?? null;
}

function tcgDetailForFinish(
  raw: Record<string, unknown> | null,
  finish: "Normal" | "Holo" | "Reverse Holo",
): ReturnType<typeof parseTcgFinishPrices> | null {
  for (const key of TRY_KEYS[finish]) {
    const d = parseTcgFinishPrices(raw?.[key]);
    if (
      d &&
      (d.market_cents != null ||
        d.low_cents != null ||
        d.high_cents != null ||
        d.direct_cents != null)
    ) {
      return d;
    }
  }
  return null;
}

function primaryPriceCentsForFinish(
  card: {
    tcgplayer_prices_by_finish?: unknown;
    tcgplayer_price_cents?: number | null;
  },
  finish: "Normal" | "Holo" | "Reverse Holo",
): number | null {
  const raw =
    card.tcgplayer_prices_by_finish &&
      typeof card.tcgplayer_prices_by_finish === "object" &&
      !Array.isArray(card.tcgplayer_prices_by_finish)
      ? (card.tcgplayer_prices_by_finish as Record<string, unknown>)
      : null;
  if (finish === "Normal") {
    const d = tcgDetailForFinish(raw, "Normal");
    const fromDetail = d ? tcgPrimaryCentsFromDetail(d) : null;
    if (fromDetail != null) return fromDetail;
    if (
      card.tcgplayer_price_cents != null &&
      Number.isFinite(Number(card.tcgplayer_price_cents))
    ) {
      return Math.round(Number(card.tcgplayer_price_cents));
    }
    return null;
  }
  const d = tcgDetailForFinish(raw, finish);
  return d ? tcgPrimaryCentsFromDetail(d) : null;
}

function dropNormalWhenSamePriceAsHolo(
  finishes: MarketCardType[],
  card: {
    tcgplayer_prices_by_finish?: unknown;
    tcgplayer_price_cents?: number | null;
  },
): MarketCardType[] {
  if (!finishes.includes("Normal") || !finishes.includes("Holo")) return finishes;
  const n = primaryPriceCentsForFinish(card, "Normal");
  const h = primaryPriceCentsForFinish(card, "Holo");
  if (n == null || h == null || n !== h) return finishes;
  return finishes.filter((f) => f !== "Normal");
}

/**
 * Finishes that have any TCGplayer price signal (subtype JSON or legacy Normal cents).
 * When Normal and Holo primary prices match (market → low → direct), Normal is omitted so only Holo is shown and comped.
 */
export function tcgplayerActiveFinishes(card: {
  tcgplayer_prices_by_finish?: unknown;
  tcgplayer_price_cents?: number | null;
}): MarketCardType[] {
  const raw =
    card.tcgplayer_prices_by_finish &&
      typeof card.tcgplayer_prices_by_finish === "object" &&
      !Array.isArray(card.tcgplayer_prices_by_finish)
      ? (card.tcgplayer_prices_by_finish as Record<string, unknown>)
      : null;
  const legacyNormal =
    card.tcgplayer_price_cents != null &&
    Number.isFinite(Number(card.tcgplayer_price_cents));
  const out: MarketCardType[] = [];
  for (const f of ORDER) {
    if (f === "Normal") {
      if (finishHasTcgPrice(raw, "Normal") || legacyNormal) out.push("Normal");
      continue;
    }
    if (finishHasTcgPrice(raw, f)) out.push(f);
  }
  return dropNormalWhenSamePriceAsHolo(out, card);
}

export function marketCompFinishesExcludedByTcg(
  allowed: readonly MarketCardType[],
): MarketCardType[] {
  return MARKET_COMP_FINISHES.filter((f) => !allowed.includes(f));
}

/** True when `card` includes tcgcsv columns (even if null) — batch loaders attach these after an explicit select. */
export function cardHasTcgPricingScope(card: PokemonCardCompSource): boolean {
  return (
    Object.prototype.hasOwnProperty.call(card, "tcgplayer_prices_by_finish") ||
    Object.prototype.hasOwnProperty.call(card, "tcgplayer_price_cents")
  );
}

/** Finishes to ingest when TCG scope is unknown — avoid deleting comps when pricing columns were not loaded. */
export function marketCompFinishesFallback(): MarketCardType[] {
  return [...MARKET_COMP_FINISHES];
}
