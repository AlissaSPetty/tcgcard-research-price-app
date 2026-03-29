import {
  plainTextFromRssDescriptionRaw,
  shippingCentsFromSoldText,
  type SoldRssCompRow,
} from "./ebay_rss_sold.ts";

export type MarketCardType = "Normal" | "Holo" | "Reverse Holo" | "Full Art";

/** `unknown` = RSS text had no parseable shipping (common for rssbay: price only, no +$ line). */
export type ShippingEntry = "free" | "unknown" | number;

const RING = 5;

const CARD_TYPE_RULES: Array<{ type: MarketCardType; re: RegExp }> = [
  { type: "Full Art", re: /\bfull\s*art\b/i },
  { type: "Reverse Holo", re: /\breverse\s*holo(foil)?\b/i },
  { type: "Holo", re: /\bholo(foil)?\b/i },
];

export function detectCardType(title: string): MarketCardType {
  for (const r of CARD_TYPE_RULES) {
    if (r.re.test(title)) return r.type;
  }
  return "Normal";
}

export function extractCardNumber(title: string): string | null {
  const m = title.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

export function extractQuantityFromTitle(title: string): number {
  const m = title.match(/\bx\s*(\d+)\b/i);
  if (!m) return 1;
  const q = Number.parseInt(m[1], 10);
  return Number.isNaN(q) || q < 1 ? 1 : q;
}

/**
 * Heuristic: strip leading "Pokemon TCG" / "Pokemon", take tokens before the first ###/### pattern.
 */
export function extractCardName(title: string): string {
  let t = title.replace(/^\s*pokemon\s+tcg\s+/i, "")
    .replace(/^\s*pokemon\s+/i, "")
    .trim();
  const numIdx = t.search(/\b\d{1,3}\s*\/\s*\d{1,3}\b/);
  if (numIdx > 0) t = t.slice(0, numIdx).trim();
  else {
    const alt = t.match(/^(.+?)(?=\s+(?:holo|reverse|full|nm|lp|mp|hp|dmg)\b)/i);
    if (alt) t = alt[1].trim();
  }
  t = t.replace(/\s+/g, " ").trim();
  return t || title.trim();
}

export function ebayItemIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/itm\/(\d+)/i);
  return m?.[1] ?? null;
}

/**
 * True when the RSS row points at the same eBay listing as the DB row (item id if present, else exact URL).
 * Used to avoid duplicating price/shipping ring entries when the feed repeats the same item.
 */
export function isSameMarketListingUrl(
  existing: { listing_url: string | null; ebay_item_id: string | null },
  nextUrl: string | null,
  nextEbayId: string | null,
): boolean {
  const prevId =
    (existing.ebay_item_id && String(existing.ebay_item_id).trim()) ||
    ebayItemIdFromUrl(existing.listing_url);
  const nextId =
    (nextEbayId && String(nextEbayId).trim()) || ebayItemIdFromUrl(nextUrl);
  if (prevId && nextId) return prevId === nextId;
  const prevUrl = (existing.listing_url ?? "").trim();
  const nu = (nextUrl ?? "").trim();
  return prevUrl.length > 0 && nu.length > 0 && prevUrl === nu;
}

/** Parse rssbay-style HTML descriptions for shipping (same rules as RSS row parser). */
export function shippingFromListingDescription(html: string): ShippingEntry {
  const plain = plainTextFromRssDescriptionRaw(html);
  const cents = shippingCentsFromSoldText(plain);
  if (cents != null) return cents === 0 ? "free" : cents;
  return "unknown";
}

/**
 * rssbay uses `Listed since: Mar-27 14:49` (no year). Prefer `pubYear` from &lt;pubDate&gt;.
 */
export function listedDateFromDescription(
  html: string,
  pubYear?: number,
): string | null {
  const m = html.match(
    /Listed\s+since:\s*([A-Za-z]{3})-(\d{1,2})\s+(\d{1,2}:\d{2})/i,
  );
  if (!m) return null;
  const year = pubYear ?? new Date().getFullYear();
  const mon = m[1];
  const day = Number.parseInt(m[2], 10);
  const t = Date.parse(`${mon} ${day}, ${year}`);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

export function appendPriceRing(
  history: number[],
  nextCents: number,
): number[] {
  return [...history, nextCents].slice(-RING);
}

/** Last `RING` distinct prices, preserving recency (scan from end). */
export function appendUniquePriceRing(
  history: number[],
  nextCents: number,
): number[] {
  const combined = [...history, nextCents];
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = combined.length - 1; i >= 0 && out.length < RING; i--) {
    const c = combined[i];
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out.reverse();
}

export function appendShippingRing(
  history: ShippingEntry[],
  next: ShippingEntry,
): ShippingEntry[] {
  return [...history, next].slice(-RING);
}

export function averagePriceCents(history: number[]): number | null {
  if (!history.length) return null;
  return Math.round(
    history.reduce((a, b) => a + b, 0) / history.length,
  );
}

export function shippingAverageFromHistory(
  history: ShippingEntry[],
): { free: true } | { free: false; cents: number | null } {
  const nums = history.filter((h): h is number => typeof h === "number");
  if (nums.length > 0) {
    return {
      free: false,
      cents: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length),
    };
  }
  const freeCount = history.filter((h) => h === "free").length;
  const unknownCount = history.filter((h) => h === "unknown").length;
  if (unknownCount > 0 && freeCount === 0) {
    return { free: false, cents: null };
  }
  if (freeCount > 0 && unknownCount === 0) return { free: true };
  if (freeCount > unknownCount) return { free: true };
  if (unknownCount >= freeCount && unknownCount > 0) {
    return { free: false, cents: null };
  }
  return { free: true };
}

export function shippingHistoryToJson(
  history: ShippingEntry[],
): Array<number | string> {
  return history.map((h) =>
    h === "free" ? "free" : h === "unknown" ? "unknown" : h
  );
}

export function shippingHistoryFromJson(
  raw: unknown,
): ShippingEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ShippingEntry[] = [];
  for (const x of raw) {
    if (x === "free" || x === null) out.push("free");
    else if (x === "unknown") out.push("unknown");
    else if (typeof x === "number" && Number.isFinite(x)) out.push(x);
  }
  return out;
}

export function priceHistoryFromJson(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is number =>
    typeof x === "number" && Number.isFinite(x)
  );
}

export interface ParsedRssListing {
  row: SoldRssCompRow;
  cardName: string;
  cardNumber: string | null;
  cardType: MarketCardType;
  quantity: number;
  listedDate: string | null;
  shipping: ShippingEntry;
  ebayItemId: string | null;
}

export function parseRssbayItem(
  row: SoldRssCompRow,
  descriptionHtml: string,
): ParsedRssListing {
  const title = row.title ?? "";
  const cardType = detectCardType(title);
  const cardNumber = extractCardNumber(title);
  const quantity = extractQuantityFromTitle(title);
  const cardName = extractCardName(title);
  const pubYear = row.pubDate
    ? new Date(row.pubDate).getFullYear()
    : undefined;
  const listedDate =
    listedDateFromDescription(descriptionHtml, pubYear) ??
    (row.pubDate
      ? new Date(row.pubDate).toISOString().slice(0, 10)
      : null);
  const descPlain = plainTextFromRssDescriptionRaw(descriptionHtml);
  const shipCents =
    row.shippingCents ??
    shippingCentsFromSoldText(`${title} ${descPlain}`.trim());
  const shipping: ShippingEntry =
    shipCents != null
      ? shipCents === 0
        ? "free"
        : shipCents
      : "unknown";
  const ebayItemId = ebayItemIdFromUrl(row.link);
  let priceCents = row.priceCents;
  if (priceCents == null && descriptionHtml) {
    const plain = descriptionHtml.replace(/<[^>]+>/g, " ");
    const usd = plain.match(/\bUSD\s*([0-9]+(?:\.[0-9]{2})?)\b/i);
    if (usd) {
      const n = Number.parseFloat(usd[1]);
      if (!Number.isNaN(n) && n > 0) priceCents = Math.round(n * 100);
    }
  }
  return {
    row: { ...row, priceCents },
    cardName,
    cardNumber,
    cardType,
    quantity,
    listedDate,
    shipping,
    ebayItemId,
  };
}

export { RING as MARKET_PRICE_RING_MAX };
