/**
 * Map tcgcsv.com TCGPlayer product + group into `pokemon_card_images` rows.
 * @see https://tcgcsv.com/docs
 */

export interface PokemonCardImageRow {
  tcgplayer_product_id: number;
  tcgplayer_price_cents: number | null;
  tcgplayer_prices_by_finish: Record<string, unknown> | null;
  name: string;
  image_url: string | null;
  holo_image_url: string | null;
  reverse_holo_image_url: string | null;
  /** Heuristic from group name (e.g. prefix before ":"). */
  series: string | null;
  card_set: string | null;
  details: string | null;
  rarity: string | null;
  evolves_from: string | null;
  artist: string | null;
  card_number: string | null;
  /** ISO YYYY-MM-DD for filter ordering. */
  set_release_date: string | null;
}

export type TcgcsvGroup = {
  groupId: number;
  name: string;
  publishedOn?: string;
};

export type TcgcsvPriceDetail = {
  subtype: string;
  market_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  direct_cents: number | null;
};

type ExtEntry = { name: string; value?: string | null };

function edGet(extendedData: ExtEntry[] | undefined, name: string): string | null {
  const e = extendedData?.find((x) => x.name === name);
  const v = e?.value;
  if (v == null) return null;
  const s = String(v).replace(/<br\s*\/?>/gi, "\n").trim();
  return s || null;
}

/** Prefer a larger art URL when tcgcsv only provides `_200w`. */
export function tcgplayerImageLarger(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  if (/_200w\.jpg$/i.test(u)) return u.replace(/_200w\.jpg$/i, "_400w.jpg");
  return u;
}

/**
 * Legacy: segment before first ":" (e.g. ME03 for ME03: Perfect Order).
 * Prefer {@link tcgcsvSeriesPrefixFromGroupName} for catalog `series` (normalized ME).
 */
export function seriesFromGroupName(groupName: string): string | null {
  const t = groupName.trim();
  if (!t) return null;
  const i = t.indexOf(":");
  if (i > 0) return t.slice(0, i).trim() || t;
  return t;
}

/**
 * TCGPlayer-style era prefix for `pokemon_card_images.series`: code before ":", strip trailing digits, uppercase.
 * Aligns with TCGdex series ids when lowercased (ME → me → Mega Evolution).
 */
export function tcgcsvSeriesPrefixFromGroupName(groupName: string): string | null {
  const raw = seriesFromGroupName(groupName);
  if (raw == null || !raw.trim()) return null;
  const code = raw.trim().replace(/\d+$/, "").trim();
  const u = code.toUpperCase();
  return u || null;
}

function parseIsoDate(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function parseUsdToCents(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** tcgcsv `/groups/{id}/prices` returns subtype rows; prefer Normal for the single catalog row per productId. */
export function pickTcgcsvPriceRowForProduct(
  rows: Record<string, unknown>[],
): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0]!;
  const normal = rows.find(
    (r) => String(r.subTypeName ?? "").trim().toLowerCase() === "normal",
  );
  return normal ?? rows[0]!;
}

/** Merge product + `/prices` row; tcgcsv omits price fields on `/products`. */
export function tcgplayerPriceCentsFrom(
  product: Record<string, unknown>,
  priceRow?: Record<string, unknown> | null,
): number | null {
  const merged: Record<string, unknown> = {
    ...product,
    ...(priceRow ?? {}),
  };
  return (
    parseUsdToCents(merged.marketPrice) ??
    parseUsdToCents(merged.lowPriceWithShipping) ??
    parseUsdToCents(merged.lowPrice) ??
    parseUsdToCents(merged.directLowPrice)
  );
}

/** Build productId → chosen price row from tcgcsv `GET .../{groupId}/prices` `results`. */
export function tcgcsvPriceRowMapFromResults(
  results: unknown[],
): Map<number, Record<string, unknown>> {
  const byPid = new Map<number, Record<string, unknown>[]>();
  for (const raw of results) {
    const r = raw as Record<string, unknown>;
    const pid = Number(r.productId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const arr = byPid.get(pid) ?? [];
    arr.push(r);
    byPid.set(pid, arr);
  }
  const out = new Map<number, Record<string, unknown>>();
  for (const [pid, rows] of byPid) {
    const picked = pickTcgcsvPriceRowForProduct(rows);
    if (picked) out.set(pid, picked);
  }
  return out;
}

/** Build productId -> finish pricing details from tcgcsv `/prices` rows. */
export function tcgcsvFinishPriceMapFromResults(
  results: unknown[],
): Map<number, Record<string, TcgcsvPriceDetail>> {
  const out = new Map<number, Record<string, TcgcsvPriceDetail>>();
  for (const raw of results) {
    const r = raw as Record<string, unknown>;
    const pid = Number(r.productId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const subtypeRaw = String(r.subTypeName ?? "").trim();
    const subtype = subtypeRaw || "Normal";
    const byFinish = out.get(pid) ?? {};
    byFinish[subtype] = {
      subtype,
      market_cents: parseUsdToCents(r.marketPrice),
      low_cents: parseUsdToCents(r.lowPrice),
      high_cents: parseUsdToCents(r.highPrice),
      direct_cents: parseUsdToCents(r.directLowPrice),
    };
    out.set(pid, byFinish);
  }
  return out;
}

/**
 * @param product — tcgcsv `results[]` product object
 * @param group — parent group (set name, release)
 */
export function mapTcgcsvProductToRow(
  product: Record<string, unknown>,
  group: TcgcsvGroup,
  /** From tcgcsv `/prices`; `/products` does not include market/low prices. */
  priceRow?: Record<string, unknown> | null,
  /** Finish price map from tcgcsv `/prices` rows for this product. */
  priceByFinish?: Record<string, TcgcsvPriceDetail> | null,
): PokemonCardImageRow | null {
  const productId = product.productId;
  if (productId == null) return null;
  const n = Number(productId);
  if (!Number.isFinite(n) || n <= 0) return null;

  const extended = product.extendedData as ExtEntry[] | undefined;
  const imageSmall = (product.imageUrl as string | undefined)?.trim() || null;
  const imageLarge = tcgplayerImageLarger(imageSmall);
  const nameRaw = String(product.name ?? "").trim() || String(n);
  const presale = product.presaleInfo as
    | { releasedOn?: string | null; isPresale?: boolean }
    | undefined;

  const setReleaseGroup = parseIsoDate(group.publishedOn);
  const setReleaseProduct = parseIsoDate(presale?.releasedOn ?? null);
  const set_release_date = setReleaseGroup ?? setReleaseProduct;
  const tcgplayer_price_cents = tcgplayerPriceCentsFrom(product, priceRow ?? null);

  const parts: string[] = [];
  const want = (label: string, name: string) => {
    const v = edGet(extended, name);
    if (v) {
      if (v.length > 2000) parts.push(`${label}: ${v.slice(0, 1997)}...`);
      else parts.push(`${label}: ${v}`);
    }
  };
  want("Rarity", "Rarity");
  want("Type", "Card Type");
  want("HP", "HP");
  want("Stage", "Stage");
  for (let a = 1; a <= 4; a++) {
    const v = edGet(extended, `Attack ${a}`) ?? edGet(extended, `Attack${a}`);
    if (v) parts.push(`Attack ${a}: ${v}`);
  }
  want("Weakness", "Weakness");
  want("Resistance", "Resistance");
  want("Retreat", "RetreatCost");
  if (edGet(extended, "Evolves From") ?? edGet(extended, "Evolves from")) {
    const ev = edGet(extended, "Evolves From") ?? edGet(extended, "Evolves from");
    if (ev) parts.push(`Evolves from: ${ev}`);
  }
  const cardText = edGet(extended, "CardText");
  if (cardText && cardText.length <= 1000) parts.push(cardText);
  if (edGet(extended, "Upc") ?? edGet(extended, "UPC")) {
    const u = edGet(extended, "Upc") ?? edGet(extended, "UPC");
    if (u) parts.push(`UPC: ${u}`);
  }
  let details = parts.join("\n").trim();
  if (details.length > 4000) details = `${details.slice(0, 3997)}...`;

  const rarity = edGet(extended, "Rarity");
  const evolves = edGet(extended, "Evolves From") ?? edGet(extended, "Evolves from");
  const artist = edGet(extended, "Illustrated by") ?? edGet(extended, "Artist");
  const cardNumber = edGet(extended, "Number");

  const gname = String(group.name ?? "").trim() || "Unknown set";

  return {
    tcgplayer_product_id: n,
    tcgplayer_price_cents,
    tcgplayer_prices_by_finish: priceByFinish ?? null,
    name: nameRaw,
    image_url: imageLarge ?? imageSmall,
    holo_image_url: imageLarge ?? imageSmall,
    reverse_holo_image_url: imageSmall ?? imageLarge,
    series: tcgcsvSeriesPrefixFromGroupName(gname),
    card_set: gname,
    details: details.length > 0 ? details : null,
    rarity: rarity,
    evolves_from: evolves,
    artist: artist,
    card_number: cardNumber,
    set_release_date: set_release_date,
  };
}
