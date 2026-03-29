import type { MarketCardType } from "./rss_market.ts";

/** Finish variants we sync from Browse (one DB row each per pokemon_card_images row). */
export const MARKET_COMP_FINISHES: MarketCardType[] = [
  "Normal",
  "Holo",
  "Reverse Holo",
];

export interface PokemonCardCompSource {
  id: string;
  name: string | null;
  card_set: string | null;
  card_number: string | null;
}

/**
 * eBay search query strings: base, + holo, + reverse holo (order per plan).
 */
export function ebayCompSearchQuery(
  row: PokemonCardCompSource,
  cardType: MarketCardType,
): string | null {
  const name = (row.name ?? "").trim();
  const set = (row.card_set ?? "").trim();
  const num = (row.card_number ?? "").trim();
  if (!name || !set || !num) return null;
  const base = `${name} ${set} ${num}`;
  if (cardType === "Normal") return base;
  if (cardType === "Holo") return `${base} holo`;
  if (cardType === "Reverse Holo") return `${base} reverse holo`;
  return null;
}

/** Stored `rss_title` / identity (not from eBay listing titles). */
export function canonicalMarketRssTitle(
  row: PokemonCardCompSource,
  cardType: MarketCardType,
): string | null {
  const name = (row.name ?? "").trim();
  const set = (row.card_set ?? "").trim();
  const num = (row.card_number ?? "").trim();
  if (!name || !set || !num) return null;
  const base = `Pokemon TCG ${name} ${set} ${num}`;
  if (cardType === "Holo") return `${base} Holo`;
  if (cardType === "Reverse Holo") return `${base} Reverse Holo`;
  return base;
}
