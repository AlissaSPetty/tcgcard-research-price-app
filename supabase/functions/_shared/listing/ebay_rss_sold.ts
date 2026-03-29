export interface SoldRssCompRow {
  title: string;
  /** Present when a USD price could be parsed from title/description. */
  priceCents: number | null;
  shippingCents: number | null;
  quantity: number | null;
  link: string | null;
  /** Plain-text excerpt from &lt;description&gt; (truncated). */
  descriptionSnippet: string | null;
  pubDate: string | null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripXmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Plain text from raw &lt;description&gt; inner HTML (CDATA, entities, tags). */
export function plainTextFromRssDescriptionRaw(raw: string): string {
  let t = raw.trim();
  const cdata = t.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/i);
  if (cdata) t = cdata[1];
  return decodeXmlEntities(stripXmlTags(t)).replace(/\s+/g, " ").trim();
}

/** Pull CDATA or plain text from an RSS element body. */
function rssElementText(raw: string): string {
  let t = raw.trim();
  const cdata = t.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/i);
  if (cdata) t = cdata[1];
  return decodeXmlEntities(stripXmlTags(t)).replace(/\s+/g, " ").trim();
}

function firstUsdPriceCents(text: string): number | null {
  const cleaned = text.replace(/\b\d+\s*to\s*\d+/gi, "");
  const usdWord = cleaned.match(/\bUSD\s*([0-9]+(?:\.[0-9]{2})?)\b/i);
  if (usdWord) {
    const n = Number.parseFloat(usdWord[1]);
    if (!Number.isNaN(n) && n > 0 && n <= 100_000) return Math.round(n * 100);
  }
  const m = cleaned.match(/\$\s*([0-9]+(?:\.[0-9]{2})?)/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (Number.isNaN(n) || n <= 0 || n > 100_000) return null;
  return Math.round(n * 100);
}

/**
 * Parse shipping USD from RSS title + description plain text (eBay / rssbay phrasing).
 * Returns 0 for explicit free shipping, null if unknown (caller may default).
 */
export function shippingCentsFromSoldText(text: string): number | null {
  if (!text.trim()) return null;
  // eBay search / listing copy often says "Free delivery" (not "shipping").
  if (/\bfree\s+(?:shipping|delivery|postage)\b/i.test(text)) return 0;

  const patterns = [
    /\+\s*US\s*\$?\s*([0-9]+(?:\.[0-9]{2})?)\s*(?:for\s+)?(?:shipping|delivery|postage)/i,
    /\+\s*\$([0-9]+(?:\.[0-9]{2})?)\s*(?:shipping|delivery|postage)/i,
    /\(\s*\+\s*US\s*\$?\s*([0-9]+(?:\.[0-9]{2})?)\s*[^)]*(?:shipping|delivery)/i,
    /(?:shipping|delivery|postage)\s*(?:cost|fee|rate|amount)?\s*[:.]?\s*(?:US\s*)?\$?\s*([0-9]+(?:\.[0-9]{2})?)/i,
    /(?:US\s*)?\$\s*([0-9]+(?:\.[0-9]{2})?)\s+(?:for\s+)?(?:shipping|delivery|postage)\b/i,
    /(?:shipping|delivery)[^$]{0,50}\$\s*([0-9]+(?:\.[0-9]{2})?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number.parseFloat(m[1]);
      if (!Number.isNaN(n) && n >= 0 && n <= 50_000) return Math.round(n * 100);
    }
  }
  return null;
}

function quantityHintFromText(text: string): number | null {
  const m = text.match(/\b(?:qty|quantity)\s*[:x]?\s*(\d+)\b/i) ??
    text.match(/\b(\d+)\s*(?:cards?|copies?)\b/i);
  if (!m) return null;
  const q = Number.parseInt(m[1], 10);
  return Number.isNaN(q) ? null : q;
}

function firstTagInner(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return block.match(re)?.[1] ?? "";
}

const DESCRIPTION_SNIPPET_MAX = 400;

function snippet(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= DESCRIPTION_SNIPPET_MAX) return t;
  return `${t.slice(0, DESCRIPTION_SNIPPET_MAX)}…`;
}

/**
 * Parse RSS &lt;item&gt; blocks (e.g. rssbay / eBay-style feeds).
 * Includes every item with a title (or link/description fallback); price is optional.
 */
export function parseEbaySoldRssItems(xml: string, maxItems: number): SoldRssCompRow[] {
  const rows: SoldRssCompRow[] = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && rows.length < maxItems) {
    const block = m[1];
    const titleRaw = firstTagInner(block, "title");
    const descRaw = firstTagInner(block, "description");
    const linkRaw = firstTagInner(block, "link");
    const guidRaw = firstTagInner(block, "guid");
    const pubRaw = firstTagInner(block, "pubDate");

    let title = rssElementText(titleRaw);
    const descPlain = rssElementText(descRaw);
    const link = rssElementText(linkRaw) || rssElementText(guidRaw) || null;
    const pubDate = pubRaw.trim() ? rssElementText(pubRaw) : null;

    if (!title) {
      title = descPlain ? snippet(descPlain) : link ?? "";
    }
    if (!title && !link && !descPlain) continue;

    const combined = `${title} ${descPlain}`;
    const priceCents = firstUsdPriceCents(combined);
    const shippingCents = shippingCentsFromSoldText(combined);
    rows.push({
      title: title || "(no title)",
      priceCents,
      shippingCents,
      quantity: quantityHintFromText(combined),
      link,
      descriptionSnippet: descPlain ? snippet(descPlain) : null,
      pubDate,
    });
  }
  return rows;
}
