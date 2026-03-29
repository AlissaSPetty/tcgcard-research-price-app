/** Shared types for listing pipeline (Edge + CLI). */

export type LpPriceSource = "ebay" | "tcg" | "blended";

export interface CardPricingInput {
  id: string;
  titleHint: string | null;
  unitPriceCents: number | null;
}

export interface CompResult {
  dailyMedianCents: number | null;
  weeklyMedianCents: number | null;
  averageCents?: number | null;
  sampleSize: number;
  raw?: Record<string, unknown>;
}

export interface PricingConfig {
  ebaySampleMin: number;
  /** If eBay sample < min, prefer TCG when available */
  tcgEnabled: boolean;
}
