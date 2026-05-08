/**
 * TCGplayer is the source of truth for which finishes exist per card.
 * Align with `supabase/functions/_shared/listing/tcg_finish_scope.ts`.
 */

export type TcgFinish = "Normal" | "Holo" | "Reverse Holo";

const ORDER: readonly TcgFinish[] = ["Normal", "Holo", "Reverse Holo"];

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

const TRY_KEYS: Record<TcgFinish, string[]> = {
  Normal: ["Normal", "normal"],
  Holo: ["Holofoil", "Holo", "holofoil"],
  "Reverse Holo": ["Reverse Holofoil", "Reverse Holo", "reverse holofoil"],
};

function finishHasTcgPrice(
  raw: Record<string, unknown> | null,
  finish: TcgFinish,
): boolean {
  for (const key of TRY_KEYS[finish]) {
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

/** Same primary as catalog UI: market → low → direct. */
function tcgPrimaryCentsFromDetail(
  d: NonNullable<ReturnType<typeof parseTcgFinishPrices>>,
): number | null {
  return d.market_cents ?? d.low_cents ?? d.direct_cents ?? null;
}

function tcgDetailForFinish(
  raw: Record<string, unknown> | null,
  finish: TcgFinish,
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
    tcgplayer_prices_by_finish?: Record<string, unknown> | null;
    tcgplayer_price_cents?: number | null;
  },
  finish: TcgFinish,
): number | null {
  const raw = card.tcgplayer_prices_by_finish ?? null;
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

function dropNormalWhenSamePriceAsHolo(finishes: TcgFinish[], card: {
  tcgplayer_prices_by_finish?: Record<string, unknown> | null;
  tcgplayer_price_cents?: number | null;
}): TcgFinish[] {
  if (!finishes.includes("Normal") || !finishes.includes("Holo")) return finishes;
  const n = primaryPriceCentsForFinish(card, "Normal");
  const h = primaryPriceCentsForFinish(card, "Holo");
  if (n == null || h == null || n !== h) return finishes;
  return finishes.filter((f) => f !== "Normal");
}

export function tcgplayerActiveFinishes(card: {
  tcgplayer_prices_by_finish?: Record<string, unknown> | null;
  tcgplayer_price_cents?: number | null;
}): TcgFinish[] {
  const raw = card.tcgplayer_prices_by_finish ?? null;
  const legacyNormal =
    card.tcgplayer_price_cents != null &&
    Number.isFinite(Number(card.tcgplayer_price_cents));
  const out: TcgFinish[] = [];
  for (const f of ORDER) {
    if (f === "Normal") {
      if (finishHasTcgPrice(raw, "Normal") || legacyNormal) out.push("Normal");
      continue;
    }
    if (finishHasTcgPrice(raw, f)) out.push(f);
  }
  return dropNormalWhenSamePriceAsHolo(out, card);
}
