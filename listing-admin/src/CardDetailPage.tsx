import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { applyThemeToDocument, type Theme } from "./theme";
import { tcgplayerActiveFinishes, type TcgFinish } from "./tcgFinishScope";
import { supabase, supabaseAnonKey, supabaseUrl } from "./supabaseClient";

type PokemonCardImageRow = {
  id: string;
  tcgplayer_product_id: number;
  tcgplayer_price_cents: number | null;
  tcgplayer_prices_by_finish: Record<string, unknown> | null;
  name: string;
  image_url: string | null;
  holo_image_url: string | null;
  reverse_holo_image_url: string | null;
  series: string | null;
  card_set: string | null;
  details: string | null;
  rarity: string | null;
  artist: string | null;
  card_number: string | null;
  created_at: string;
  updated_at: string;
};

type MarketSoldCompRow = {
  id: string;
  pokemon_card_image_id: string | null;
  card_type: string;
  average_price_cents: number | null;
  sample_size: number;
  updated_at: string;
};

type BinRow = {
  id: string;
  card_type: string;
  average_price_cents: number | null;
  updated_at: string | null;
  listing_url: string | null;
  price_cents_history: unknown;
  ebay_item_id: string | null;
  rss_title: string | null;
};

function fmtCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRelativeAgo(iso: string | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: d > 300 ? "numeric" : undefined,
  });
}

function formatCardNumberDisplay(n: string | null | undefined): string {
  if (n == null) return "—";
  const t = n.trim();
  if (!t) return "—";
  const m = t.match(/^(\d{1,4})\s*\/\s*(\d{1,4})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return t;
}

type TcgFinishPrices = {
  market_cents: number | null;
  low_cents: number | null;
  high_cents: number | null;
  direct_cents: number | null;
};

function parseTcgFinishPrices(v: unknown): TcgFinishPrices | null {
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

function tcgcsvPricesForFinish(
  raw: Record<string, unknown> | null | undefined,
  finish: TcgFinish,
): TcgFinishPrices | null {
  if (!raw) return null;
  const tryKeys: Record<TcgFinish, string[]> = {
    Normal: ["Normal", "normal"],
    Holo: ["Holofoil", "Holo", "holofoil"],
    "Reverse Holo": ["Reverse Holofoil", "Reverse Holo", "reverse holofoil"],
  };
  for (const key of tryKeys[finish]) {
    const d = parseTcgFinishPrices(raw[key]);
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

function tcgPrimaryCents(d: TcgFinishPrices | null): number | null {
  if (!d) return null;
  return d.market_cents ?? d.low_cents ?? d.direct_cents ?? null;
}

function priceHistoryNums(h: unknown): number[] {
  if (!Array.isArray(h)) return [];
  return h.filter((x): x is number => typeof x === "number");
}

type BinObservationRow = {
  card_type: string;
  price_cents: number;
  listing_url: string | null;
  ebay_item_id: string | null;
  observed_at: string;
  /** Joined from `market_rss_cards` via `market_rss_card_id`. */
  rss_title: string | null;
};

type LinkedBinSample = {
  price_cents: number;
  href: string;
  title: string;
};

function listingTitleForObservation(r: BinObservationRow): string {
  const t = r.rss_title?.trim();
  if (t) return t;
  const id = r.ebay_item_id?.trim();
  if (id) return `eBay item ${id}`;
  return "eBay listing";
}

/** Avoid scheme-less hostnames being resolved as paths on the current origin. */
function normalizeListingUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("//")) return `https:${t}`;
  if (/^(?:www\.)?ebay\.com\b/i.test(t)) return `https://${t}`;
  return t;
}

function ebayListingHref(row: {
  listing_url: string | null;
  ebay_item_id: string | null;
}): string | null {
  const u = row.listing_url?.trim();
  if (u) return normalizeListingUrl(u);
  const id = row.ebay_item_id?.trim();
  if (id) return `https://www.ebay.com/itm/${encodeURIComponent(id)}`;
  return null;
}

/**
 * Observation rows are loaded newest-first. Keep only one sample per exact
 * listing URL so one eBay item cannot show up repeatedly with stale prices.
 */
function linkedSamplesFromObservations(
  rows: BinObservationRow[],
  finish: string,
  max = 3,
): LinkedBinSample[] {
  const filtered = rows.filter((r) => r.card_type === finish);
  const seenHrefs = new Set<string>();
  const newestDistinctFirst: LinkedBinSample[] = [];
  for (const r of filtered) {
    const href = ebayListingHref(r);
    if (!href) continue;
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);
    newestDistinctFirst.push({
      price_cents: r.price_cents,
      href,
      title: listingTitleForObservation(r),
    });
    if (newestDistinctFirst.length >= max) break;
  }
  return newestDistinctFirst.slice().reverse();
}

function linkedSamplesForFinish(
  finish: TcgFinish,
  observations: BinObservationRow[],
  binRow: BinRow | undefined,
): LinkedBinSample[] {
  const fromObs = linkedSamplesFromObservations(observations, finish, 3);
  if (fromObs.length > 0) return fromObs;
  const href = ebayListingHref(
    binRow ?? { listing_url: null, ebay_item_id: null },
  );
  const prices = priceHistoryNums(binRow?.price_cents_history);
  const latestPrice = prices.length > 0 ? prices[prices.length - 1] : null;
  if (!href || latestPrice == null) return [];
  const title =
    binRow?.rss_title?.trim() ||
    (binRow?.ebay_item_id ? `eBay item ${binRow.ebay_item_id}` : "eBay listing");
  return [{ price_cents: latestPrice, href, title }];
}

type CardFetchResponse = {
  ok?: boolean;
  cached?: boolean;
  cooldownMinutes?: number;
  fetchedAt?: string | null;
  rows?: BinRow[];
  errors?: string[];
  error?: string;
};

type SoldFetchResponse = {
  ok?: boolean;
  cached?: boolean;
  cooldownMinutes?: number;
  fetchedAt?: string | null;
  rows?: MarketSoldCompRow[];
  errors?: string[];
  error?: string;
  searches?: number;
  findingDiagnostics?: Array<{
    card_type: string;
    query_preview: string;
    sample_size: number;
    raw?: Record<string, unknown>;
  }>;
  /** True when amounts came from Browse BIN because Finding was unavailable / rate-limited. */
  soldBrowseFallbackUsed?: boolean;
};

export type CardDetailPageProps = {
  session: Session;
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  onSignOut: () => void;
};

export default function CardDetailPage({
  session,
  theme,
  setTheme,
  onSignOut,
}: CardDetailPageProps) {
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const { cardId } = useParams<{ cardId: string }>();
  const [card, setCard] = useState<PokemonCardImageRow | null>(null);
  const [soldByFinish, setSoldByFinish] = useState<
    Record<string, MarketSoldCompRow>
  >({});
  const [binRows, setBinRows] = useState<BinRow[]>([]);
  const [binObservations, setBinObservations] = useState<BinObservationRow[]>(
    [],
  );
  const [binLoading, setBinLoading] = useState(true);
  const [binError, setBinError] = useState<string | null>(null);
  const [cachedNotice, setCachedNotice] = useState<string | null>(null);
  const [fetchedMeta, setFetchedMeta] = useState<{
    fetchedAt: string | null;
    cached: boolean;
  } | null>(null);
  const [soldBusy, setSoldBusy] = useState(false);
  const [soldManualBusy, setSoldManualBusy] = useState(false);
  const [soldError, setSoldError] = useState<string | null>(null);
  const [soldCachedNotice, setSoldCachedNotice] = useState<string | null>(null);
  const [soldFetchedMeta, setSoldFetchedMeta] = useState<{
    fetchedAt: string | null;
    cached: boolean;
  } | null>(null);
  const [soldBrowseFallbackNotice, setSoldBrowseFallbackNotice] =
    useState(false);
  const [enlargedImageUrl, setEnlargedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    setSoldBrowseFallbackNotice(false);
  }, [cardId]);

  useEffect(() => {
    if (!enlargedImageUrl) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlargedImageUrl(null);
    };
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [enlargedImageUrl]);

  const loadCardAndSold = useCallback(async () => {
    if (!cardId) return;
    const { data: row, error: e1 } = await supabase
      .from("pokemon_card_images_with_market_activity")
      .select(
        "id, tcgplayer_product_id, tcgplayer_price_cents, tcgplayer_prices_by_finish, name, image_url, holo_image_url, reverse_holo_image_url, series, card_set, details, rarity, artist, card_number, created_at, updated_at",
      )
      .eq("id", cardId)
      .maybeSingle();
    if (e1) {
      setBinError(e1.message);
      setCard(null);
      return;
    }
    setCard((row ?? null) as PokemonCardImageRow | null);

    const { data: soldRows, error: e2 } = await supabase
      .from("market_sold_comps")
      .select("id, pokemon_card_image_id, card_type, average_price_cents, sample_size, updated_at")
      .eq("pokemon_card_image_id", cardId);
    if (e2) {
      setBinError(e2.message);
      return;
    }
    const sm: Record<string, MarketSoldCompRow> = {};
    for (const r of (soldRows ?? []) as MarketSoldCompRow[]) {
      sm[r.card_type] = r;
    }
    setSoldByFinish(sm);
  }, [cardId]);

  const fetchBinObservations = useCallback(async () => {
    if (!cardId) return;
    const { data, error } = await supabase
      .from("market_rss_active_observations")
      .select(
        "card_type, price_cents, listing_url, ebay_item_id, observed_at, market_rss_cards ( rss_title )",
      )
      .eq("pokemon_card_image_id", cardId)
      .order("observed_at", { ascending: false })
      .limit(250);
    if (error) {
      setBinObservations([]);
      return;
    }
    type RawObs = {
      card_type: string;
      price_cents: number;
      listing_url: string | null;
      ebay_item_id: string | null;
      observed_at: string;
      market_rss_cards: { rss_title: string | null } | null;
    };
    const rows = ((data ?? []) as RawObs[]).map((r) => ({
      card_type: r.card_type,
      price_cents: r.price_cents,
      listing_url: r.listing_url,
      ebay_item_id: r.ebay_item_id,
      observed_at: r.observed_at,
      rss_title: r.market_rss_cards?.rss_title ?? null,
    }));
    setBinObservations(rows);
  }, [cardId]);

  const fetchBinComps = useCallback(
    async () => {
      if (!cardId) return;
      setBinLoading(true);
      setBinError(null);
      setCachedNotice(null);
      try {
        const { data, error } = await supabase.functions.invoke<CardFetchResponse>(
          "market-comps-card-fetch",
          {
            body: { pokemon_card_image_id: cardId, force: false },
          },
        );
        if (error) {
          setBinError(error.message);
          return;
        }
        const payload = data as CardFetchResponse | null;
        if (payload?.error) {
          setBinError(payload.error);
          return;
        }
        if (!payload?.ok) {
          setBinError("Unexpected response from server");
          return;
        }
        setBinRows((payload.rows ?? []) as BinRow[]);
        setFetchedMeta({
          fetchedAt: payload.fetchedAt ?? null,
          cached: Boolean(payload.cached),
        });
        if (payload.cached) {
          const m = payload.cooldownMinutes ?? 15;
          setCachedNotice(`Using cached results (refresh allowed every ${m} minutes).`);
        }
        const errs = payload.errors?.filter(Boolean);
        if (errs && errs.length > 0 && !(payload.rows && payload.rows.length > 0)) {
          setBinError(errs.join("; "));
        }
      } finally {
        setBinLoading(false);
        void fetchBinObservations();
      }
    },
    [cardId, fetchBinObservations],
  );

  const fetchSoldComps = useCallback(
    async (force: boolean) => {
      if (!cardId) return;
      setSoldManualBusy(force);
      setSoldBusy(true);
      setSoldError(null);
      setSoldCachedNotice(null);
      setSoldBrowseFallbackNotice(false);
      try {
        const { data, error } = await supabase.functions.invoke<SoldFetchResponse>(
          "market-sold-comps-card-fetch",
          {
            body: { pokemon_card_image_id: cardId, force },
          },
        );
        if (error) {
          setSoldError(error.message);
          return;
        }
        const payload = data as SoldFetchResponse | null;
        if (payload?.error) {
          setSoldError(payload.error);
          return;
        }
        if (!payload?.ok) {
          setSoldError("Unexpected response from server");
          return;
        }
        const sm: Record<string, MarketSoldCompRow> = {};
        for (const r of (payload.rows ?? []) as MarketSoldCompRow[]) {
          sm[r.card_type] = r;
        }
        setSoldByFinish(sm);
        setSoldFetchedMeta({
          fetchedAt: payload.fetchedAt ?? null,
          cached: Boolean(payload.cached),
        });
        if (!payload.cached && payload.soldBrowseFallbackUsed != null) {
          setSoldBrowseFallbackNotice(Boolean(payload.soldBrowseFallbackUsed));
        }
        if (payload.cached) {
          const m = payload.cooldownMinutes ?? 60;
          setSoldCachedNotice(
            `Using cached sold comps (refresh allowed every ${m} minutes unless you choose Refresh).`,
          );
        }
        const errs = payload.errors?.filter(Boolean);
        if (errs && errs.length > 0) {
          setSoldError(errs.join("; "));
        }
      } finally {
        setSoldBusy(false);
        setSoldManualBusy(false);
      }
    },
    [cardId],
  );

  useEffect(() => {
    void loadCardAndSold();
  }, [loadCardAndSold]);

  const sessionUserId = session.user.id;

  useEffect(() => {
    if (!cardId || !sessionUserId) return;
    void fetchBinComps();
  }, [cardId, sessionUserId, fetchBinComps]);

  useEffect(() => {
    if (!cardId || !sessionUserId) return;
    void fetchSoldComps(false);
  }, [cardId, sessionUserId, fetchSoldComps]);

  const binByFinish = useMemo(() => {
    const m: Record<string, BinRow> = {};
    for (const r of binRows) {
      m[r.card_type] = r;
    }
    return m;
  }, [binRows]);

  const activeFinishes = useMemo((): TcgFinish[] => {
    if (!card) return [];
    return tcgplayerActiveFinishes({
      tcgplayer_prices_by_finish: card.tcgplayer_prices_by_finish,
      tcgplayer_price_cents: card.tcgplayer_price_cents,
    });
  }, [card]);

  const binShowSkeleton = binLoading && fetchedMeta === null;
  const binShowOverlay = binLoading && fetchedMeta !== null;

  if (!supabaseUrl || !supabaseAnonKey) {
    return (
      <p className="error">
        Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this app.
      </p>
    );
  }

  if (!cardId) {
    return <p className="error">Missing card id.</p>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-row">
          <Link to="/" className="secondary card-detail-back">
            ← Back to catalog
          </Link>
          <h1 className="app-title">Card details</h1>
        </div>
        <div className="app-header-actions">
          <button
            type="button"
            className="theme-toggle secondary"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? "Dark mode" : "Light mode"}
          </button>
          <p className="app-header-meta">
            Signed in as {session.user.email}{" "}
            <button type="button" className="secondary" onClick={() => void onSignOut()}>
              Sign out
            </button>
          </p>
        </div>
      </header>

      {!card && !binError && (
        <p className="text-muted text-sm">Loading card…</p>
      )}
      {card && (
        <>
          <article className="card-detail-identity">
            <div className="card-detail-media">
              {card.image_url ? (
                <button
                  type="button"
                  className="card-detail-media-button"
                  onClick={() => setEnlargedImageUrl(card.image_url)}
                  aria-label={`View large image: ${card.name}`}
                >
                  <img src={card.image_url} alt="" decoding="async" />
                </button>
              ) : (
                <div className="pokemon-card-media--empty">No image</div>
              )}
            </div>
            <div className="card-detail-meta">
              <h2>{card.name}</h2>
              <ul className="pokemon-card-meta">
                <li>
                  <strong>Series:</strong> {card.series ?? "—"}
                </li>
                <li>
                  <strong>Set:</strong> {card.card_set ?? "—"}
                </li>
                <li>
                  <strong>#</strong> {formatCardNumberDisplay(card.card_number)}
                </li>
                <li>
                  <strong>Rarity:</strong> {card.rarity ?? "—"}
                </li>
              </ul>
              <p className="pokemon-card-fetched">
                <time dateTime={card.updated_at} title={card.updated_at}>
                  TCGplayer/catalog: {formatRelativeAgo(card.updated_at)}
                </time>
              </p>
            </div>
          </article>

          <section
            className="card-detail-section"
            aria-busy={soldBusy || undefined}
          >
            <div className="card-detail-bin-header">
              <h3>Market overview</h3>
              <button
                type="button"
                className="secondary"
                disabled={soldBusy}
                onClick={() => void fetchSoldComps(true)}
              >
                {soldManualBusy
                  ? "Refreshing…"
                  : soldBusy
                    ? "Updating…"
                    : "Refresh sold comps"}
              </button>
            </div>
            <p className="text-muted text-sm">
              Sold comps from eBay (Finding API) and TCGplayer subtype prices — same as the catalog grid.
            </p>
            {soldBrowseFallbackNotice && (
              <p className="text-muted text-sm" role="status">
                eBay sold (Finding) was rate-limited or unavailable; the amounts below
                are from <strong>active Buy It Now</strong> listings as an estimate, not
                completed sales.
              </p>
            )}
            {soldCachedNotice && (
              <p className="text-muted text-sm" role="status">
                {soldCachedNotice}
              </p>
            )}
            {soldError && (
              <p className="error">
                {soldError}{" "}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void fetchSoldComps(false)}
                >
                  Retry
                </button>
              </p>
            )}
            <div className="card-detail-section-busy-wrap">
              {soldBusy && (
                <div
                  className="card-detail-section-busy-overlay"
                  aria-live="polite"
                  role="status"
                >
                  <div className="card-detail-refresh-spinner" aria-hidden />
                  <span className="card-detail-section-busy-label">
                    {soldManualBusy ? "Refreshing sold comps…" : "Updating sold comps…"}
                  </span>
                </div>
              )}
              <table className="market-pricing-table card-detail-market-table">
                <thead>
                  <tr>
                    <th scope="col">Finish</th>
                    <th scope="col">eBay sold</th>
                    <th scope="col">TCGplayer</th>
                  </tr>
                </thead>
                <tbody>
                  {activeFinishes.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-muted text-sm">
                        No TCGplayer prices for any finish on this card — eBay sold comps and BIN pricing are not applicable.
                      </td>
                    </tr>
                  ) : (
                    activeFinishes.map((finish) => {
                      const soldRow = soldByFinish[finish];
                      const tcgRaw = card.tcgplayer_prices_by_finish as
                        | Record<string, unknown>
                        | null
                        | undefined;
                      const tcgDetail = tcgcsvPricesForFinish(tcgRaw ?? null, finish);
                      const tcgSummary =
                        tcgPrimaryCents(tcgDetail) ??
                        (finish === "Normal" ? card.tcgplayer_price_cents : null);
                      return (
                        <tr key={finish}>
                          <td>{finish}</td>
                          <td className="tabular-nums">
                            {soldRow ? (
                              <>
                                {fmtCents(soldRow.average_price_cents)}
                                <span className="text-muted text-sm">
                                  {" "}
                                  (n={soldRow.sample_size},{" "}
                                  {formatRelativeAgo(soldRow.updated_at)})
                                </span>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="tabular-nums">{fmtCents(tcgSummary)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
              {soldFetchedMeta?.fetchedAt && (
                <p className="text-muted text-sm card-detail-asof">
                  Sold as of{" "}
                  <time
                    dateTime={soldFetchedMeta.fetchedAt}
                    title={soldFetchedMeta.fetchedAt}
                  >
                    {formatRelativeAgo(soldFetchedMeta.fetchedAt)} (
                    {new Date(soldFetchedMeta.fetchedAt).toLocaleString()})
                  </time>
                  .
                </p>
              )}
            </div>
          </section>

          <section
            className="card-detail-section card-detail-bin"
            aria-busy={binLoading || undefined}
          >
            <div className="card-detail-bin-header">
              <h3>Buy It Now on eBay</h3>
            </div>
            <p className="text-muted text-sm">
              Averages come from search-derived Buy It Now listings; they are not a guaranteed checkout price.
            </p>

            {cachedNotice && (
              <p className="text-muted text-sm" role="status">
                {cachedNotice}
              </p>
            )}

            <div className="card-detail-bin-body" aria-busy={binLoading || undefined}>
              {binShowSkeleton && (
                <p className="card-detail-bin-loading-msg text-muted text-sm" aria-live="polite">
                  Fetching Buy It Now listings from eBay…
                </p>
              )}

              {!binShowSkeleton && binError && (
                <p className="error">
                  {binError}{" "}
                  <button type="button" className="secondary" onClick={() => void fetchBinComps()}>
                    Retry
                  </button>
                </p>
              )}

              {!binShowSkeleton && !binError && fetchedMeta && (
                <div className="card-detail-section-busy-wrap card-detail-bin-results-wrap">
                  {binShowOverlay && (
                    <div
                      className="card-detail-section-busy-overlay"
                      aria-live="polite"
                      role="status"
                    >
                      <div className="card-detail-refresh-spinner" aria-hidden />
                      <span className="card-detail-section-busy-label">
                        Updating Buy It Now listings…
                      </span>
                    </div>
                  )}
                  <p className="text-muted text-sm card-detail-asof">
                    Results as of{" "}
                    {fetchedMeta.fetchedAt
                      ? `${formatRelativeAgo(fetchedMeta.fetchedAt)} (${new Date(fetchedMeta.fetchedAt).toLocaleString()})`
                      : "—"}
                    .
                  </p>
                  {activeFinishes.length === 0 ? (
                    <p className="text-muted text-sm card-detail-bin-empty-finishes">
                      No TCGplayer-priced finishes — Buy It Now listings are not fetched for this card.
                    </p>
                  ) : (
                    <div className="card-detail-bin-sample-groups">
                      {activeFinishes.map((finish) => {
                        const row = binByFinish[finish];
                        const samples = linkedSamplesForFinish(
                          finish,
                          binObservations,
                          row,
                        );
                        return (
                          <div key={finish} className="card-detail-bin-finish-block">
                            <h4 className="card-detail-bin-finish-heading">{finish}</h4>
                            {samples.length > 0 ? (
                              <ul className="card-detail-bin-finish-prices">
                                {samples.map((s, idx) => (
                                  <li key={`${finish}-${s.price_cents}-${idx}`}>
                                    <a
                                      href={s.href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      {s.title}
                                    </a>
                                    <span className="tabular-nums">
                                      {" "}
                                      ({fmtCents(s.price_cents)})
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-muted text-sm card-detail-bin-finish-empty">
                                —
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {binError && !card && <p className="error">{binError}</p>}

      {enlargedImageUrl && card && (
        <div
          className="card-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Large image: ${card.name}`}
          onClick={() => setEnlargedImageUrl(null)}
        >
          <div
            className="card-image-lightbox-content"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="card-image-lightbox-close secondary"
              onClick={() => setEnlargedImageUrl(null)}
            >
              Close
            </button>
            <img
              src={enlargedImageUrl}
              alt={card.name}
              className="card-image-lightbox-img"
              decoding="async"
            />
          </div>
        </div>
      )}
    </div>
  );
}
