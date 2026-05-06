import type { CompResult } from "./types.ts";
import {
  ebayApiOrigin,
  ebayOAuthTokenUrl,
  ebayUseSandbox,
} from "./ebay_env.ts";
import type { ShippingEntry } from "./rss_market.ts";

/** Active BIN listing from Browse `item_summary` search. */
export interface BrowseBinListing {
  itemId: string;
  itemWebUrl: string;
  priceCents: number;
  shipping: ShippingEntry;
  /** ISO date `YYYY-MM-DD` when API provides creation/listing time. */
  listedDate: string | null;
}

function browseBase(): string {
  return `${ebayApiOrigin()}/buy/browse/v1`;
}

/** Finding Service host: derive from App ID only — do not use ebayApiOrigin() / EBAY_USE_SANDBOX here. */
function findingBase(appId: string | null): string {
  const appLooksSandbox = (appId ?? "").includes("-SBX-");
  return appLooksSandbox
    ? "https://svcs.sandbox.ebay.com/services/search/FindingService/v1"
    : "https://svcs.ebay.com/services/search/FindingService/v1";
}

/**
 * Application-derived OAuth token (client credentials) for Browse API search only.
 */
export async function ebayClientCredentialsToken(
  appId: string,
  certId: string,
): Promise<string> {
  const basic = btoa(`${appId}:${certId}`);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });
  const res = await fetch(ebayOAuthTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    const tokenUrl = ebayOAuthTokenUrl();
    const sandbox = ebayUseSandbox();
    const hint =
      res.status === 401 && /invalid_client/i.test(t)
        ? ` (token host: ${tokenUrl}; EBAY_USE_SANDBOX=${sandbox}. Production keys: api.ebay.com; omit EBAY_USE_SANDBOX or set false. Sandbox keys: set EBAY_USE_SANDBOX=true. Keys must be Client ID + secret from the same eBay app row.)`
        : "";
    throw new Error(`eBay token error: ${res.status} ${t}${hint}`);
  }
  const j = await res.json();
  return j.access_token as string;
}

interface BrowseItem {
  price?: { value: string; currency?: string };
}

function shippingEntryFromBrowseSummary(
  item: Record<string, unknown>,
): ShippingEntry {
  const opts = item.shippingOptions;
  if (!Array.isArray(opts) || opts.length === 0) return "unknown";
  const first = opts[0] as Record<string, unknown> | undefined;
  const cost = first?.shippingCost as Record<string, unknown> | undefined;
  const val = cost?.value;
  if (val == null) return "unknown";
  const n = Number.parseFloat(String(val));
  if (Number.isNaN(n)) return "unknown";
  if (n <= 0) return "free";
  if (n > 500) return "unknown";
  return Math.round(n * 100);
}

function listedDateFromBrowseSummary(
  item: Record<string, unknown>,
): string | null {
  const raw = item.itemCreationDate ?? item.itemEndDate;
  if (raw == null || typeof raw !== "string") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** eBay Browse `errors[]`: ACCESS / REQUEST throttling (e.g. errorId 2001 — "Too many requests."). */
function browseErrorsIndicateRateLimit(json: Record<string, unknown>): boolean {
  const errs = json.errors;
  if (!Array.isArray(errs)) return false;
  for (const e of errs) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    const id = Number(o.errorId);
    if (id === 2001) return true;
    const domain = String(o.domain ?? "").toUpperCase();
    const category = String(o.category ?? "").toUpperCase();
    if (domain === "ACCESS" && category === "REQUEST") return true;
  }
  return false;
}

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw == null || raw.trim() === "") return null;
  const sec = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(120_000, sec * 1000);
}

/** eBay Browse may return 429 or a JSON error such as "The request limit has been reached for the resource." */
function browseResponseIsRateLimited(
  status: number,
  bodyText: string,
  json: Record<string, unknown>,
): boolean {
  if (status === 429) return true;
  if (browseErrorsIndicateRateLimit(json)) return true;
  const blob = `${bodyText} ${JSON.stringify(json)}`.toLowerCase();
  if (
    blob.includes("request limit") ||
    blob.includes("rate limit") ||
    blob.includes("too many requests")
  ) {
    return true;
  }
  if (blob.includes("exceeded") && blob.includes("quota")) return true;
  return false;
}

function parseBrowseItemSummaries(
  data: Record<string, unknown>,
): BrowseBinListing[] {
  const summaries = data.itemSummaries;
  if (!Array.isArray(summaries)) return [];

  const items: BrowseBinListing[] = [];
  for (const raw of summaries) {
    const item = raw as Record<string, unknown>;
    const itemId = String(item.itemId ?? "").trim();
    const itemWebUrl = String(item.itemWebUrl ?? "").trim();
    const priceBlock = item.price as Record<string, unknown> | undefined;
    const pv = priceBlock?.value;
    if (!itemId || !itemWebUrl || pv == null) continue;
    const n = Math.round(Number.parseFloat(String(pv)) * 100);
    if (Number.isNaN(n) || n <= 0 || n > 10_000_000) continue;
    items.push({
      itemId,
      itemWebUrl,
      priceCents: n,
      shipping: shippingEntryFromBrowseSummary(item),
      listedDate: listedDateFromBrowseSummary(item),
    });
  }
  return items;
}

/** Tuned for Supabase Edge CPU/time: long retry chains cause 504 / WORKER_LIMIT. Override via MARKET_COMPS_BROWSE_MAX_RETRIES. */
function browseRateLimitMaxAttempts(): number {
  const g = globalThis as {
    Deno?: { env: { get: (k: string) => string | undefined } };
  };
  const raw = g.Deno?.env.get("MARKET_COMPS_BROWSE_MAX_RETRIES")?.trim();
  if (!raw) return 4;
  const n = Number(raw);
  return Math.min(10, Math.max(1, Number.isFinite(n) ? n : 4));
}

const BROWSE_RATE_LIMIT_BACKOFF_CAP_MS = 8_000;
const BROWSE_RATE_LIMIT_BASE_BACKOFF_MS = 1_200;

async function searchBrowseBinListingsOnce(
  token: string,
  query: string,
  limit: number,
): Promise<{
  items: BrowseBinListing[];
  error?: string;
  status?: number;
  rateLimited?: boolean;
  /** Server hint (seconds → ms), when eBay sends Retry-After */
  retryAfterMs?: number | null;
}> {
  const q = encodeURIComponent(query.slice(0, 120));
  const url =
    `${browseBase()}/item_summary/search?q=${q}&limit=${limit}&filter=buyingOptions:{FIXED_PRICE}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  const retryAfterMs = parseRetryAfterMs(res);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const rateLimited = browseResponseIsRateLimited(res.status, text, json);
    return {
      items: [],
      error: text.slice(0, 500),
      status: res.status,
      rateLimited,
      retryAfterMs,
    };
  }

  const errs = json.errors;
  if (Array.isArray(errs) && errs.length > 0) {
    const rateLimited = browseResponseIsRateLimited(res.status, text, json);
    return {
      items: [],
      error: text.slice(0, 500),
      status: res.status,
      rateLimited,
      retryAfterMs,
    };
  }

  return { items: parseBrowseItemSummaries(json) };
}

/**
 * Active fixed-price (BIN) listings for a search query (US marketplace).
 * Retries with backoff when eBay returns a rate limit / quota error.
 */
export async function searchBrowseBinListings(
  token: string,
  query: string,
  limit = 25,
): Promise<{ items: BrowseBinListing[]; error?: string; status?: number }> {
  const maxAttempts = browseRateLimitMaxAttempts();
  let last: Awaited<ReturnType<typeof searchBrowseBinListingsOnce>> | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      let backoff = Math.min(
        BROWSE_RATE_LIMIT_BACKOFF_CAP_MS,
        BROWSE_RATE_LIMIT_BASE_BACKOFF_MS * 2 ** (attempt - 1),
      );
      if (last?.retryAfterMs != null) {
        backoff = Math.max(backoff, last.retryAfterMs);
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
    last = await searchBrowseBinListingsOnce(token, query, limit);
    if (!last.error) return last;
    if (!last.rateLimited) return last;
  }
  return last ?? { items: [] };
}

/**
 * Uses active Buy-It-Now listings as a market proxy (sold comps need Terapeak/partner access).
 * Takes price values from first page, returns medians as daily/weekly same value for v1.
 */
export async function fetchMarketCompsBrowse(
  token: string,
  query: string,
  limit = 25,
): Promise<CompResult> {
  const q = encodeURIComponent(query.slice(0, 120));
  const url =
    `${browseBase()}/item_summary/search?q=${q}&limit=${limit}&filter=buyingOptions:{FIXED_PRICE}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!res.ok) {
    const t = await res.text();
    return {
      dailyMedianCents: null,
      weeklyMedianCents: null,
      sampleSize: 0,
      raw: { error: t, status: res.status },
    };
  }

  const data = await res.json();
  const items: BrowseItem[] = data.itemSummaries ?? [];
  const cents: number[] = [];
  for (const it of items) {
    const v = it.price?.value;
    if (v != null) {
      const n = Math.round(parseFloat(v) * 100);
      if (!Number.isNaN(n)) cents.push(n);
    }
  }

  cents.sort((a, b) => a - b);
  const median = cents.length
    ? cents[Math.floor(cents.length / 2)]
    : null;
  const average = cents.length
    ? Math.round(cents.reduce((sum, c) => sum + c, 0) / cents.length)
    : null;

  return {
    dailyMedianCents: median,
    weeklyMedianCents: median,
    averageCents: average,
    sampleSize: cents.length,
    raw: { itemCount: items.length },
  };
}

/** Stub for tests / missing credentials */
export function mockComps(fixedCents: number): CompResult {
  return {
    dailyMedianCents: fixedCents,
    weeklyMedianCents: fixedCents,
    averageCents: fixedCents,
    sampleSize: 5,
    raw: { mock: true },
  };
}

export async function fetchSoldCompsAverageCents(
  appId: string | null,
  query: string,
  limit = 200,
): Promise<{ averageCents: number | null; sampleSize: number; raw?: Record<string, unknown> }> {
  if (!appId?.trim()) {
    return {
      averageCents: null,
      sampleSize: 0,
      raw: { reason: "no_ebay_app_id" },
    };
  }

  const id = appId.trim();
  const params = new URLSearchParams({
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": id,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "true",
    keywords: query.slice(0, 120),
    "paginationInput.entriesPerPage": String(Math.min(Math.max(limit, 1), 100)),
    "itemFilter(0).name": "SoldItemsOnly",
    "itemFilter(0).value": "true",
    "itemFilter(1).name": "GlobalId",
    "itemFilter(1).value": "EBAY_US",
    sortOrder: "EndTimeSoonest",
  });
  const findingUrl = `${findingBase(id)}?${params.toString()}`;
  const findingRes = await fetch(findingUrl);

  let findingReason: string | null = null;

  if (findingRes.ok) {
    const body = await findingRes.json() as Record<string, unknown>;
    const ack = body?.findCompletedItemsResponse?.[0]?.ack?.[0];
    if (ack && ack !== "Success" && ack !== "Warning") {
      findingReason = `finding_api_ack_error:${ack}`;
    }
    const items = normalizeFindingItems(body);
    const cents: number[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const rawPrice = item?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__;
      const n = Number.parseFloat(String(rawPrice ?? ""));
      if (Number.isNaN(n) || n <= 0 || n > 10000) continue;
      cents.push(Math.round(n * 100));
    }
    if (cents.length) {
      const average = Math.round(cents.reduce((sum, p) => sum + p, 0) / cents.length);
      return {
        averageCents: average,
        sampleSize: cents.length,
        raw: { source: "finding_api", parsedCount: cents.length },
      };
    }
    if (!findingReason) findingReason = "finding_api_no_items";
  } else {
    const errTxt = await findingRes.text();
    findingReason = `finding_api_http_error:${findingRes.status}:${errTxt.slice(0, 120)}`;
  }

  return {
    averageCents: null,
    sampleSize: 0,
    raw: { reason: findingReason ?? "finding_api_failed" },
  };
}

export type { SoldRssCompRow } from "./ebay_rss_sold.ts";
export { parseEbaySoldRssItems } from "./ebay_rss_sold.ts";

function normalizeFindingItems(body: Record<string, unknown>): unknown[] {
  const resp = (body?.findCompletedItemsResponse as unknown[] | undefined)?.[0] as
    | Record<string, unknown>
    | undefined;
  const sr = (resp?.searchResult as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const raw = sr?.item;
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}
