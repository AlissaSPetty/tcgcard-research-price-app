import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { applyThemeToDocument, type Theme } from "./theme";

const url = import.meta.env.VITE_SUPABASE_URL ?? "";
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
const supabase = createClient(url, anon);

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

const COMP_FINISH_ORDER = ["Normal", "Holo", "Reverse Holo"] as const;

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
  finish: (typeof COMP_FINISH_ORDER)[number],
): TcgFinishPrices | null {
  if (!raw) return null;
  const tryKeys: Record<(typeof COMP_FINISH_ORDER)[number], string[]> = {
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

function uniqueRecentPrices(history: unknown, max = 5): number[] {
  const nums = priceHistoryNums(history);
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = nums.length - 1; i >= 0 && out.length < max; i--) {
    const p = nums[i];
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.reverse();
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
  const [binLoading, setBinLoading] = useState(true);
  const [binError, setBinError] = useState<string | null>(null);
  const [cachedNotice, setCachedNotice] = useState<string | null>(null);
  const [fetchedMeta, setFetchedMeta] = useState<{
    fetchedAt: string | null;
    cached: boolean;
  } | null>(null);

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

  const fetchBinComps = useCallback(
    async (force: boolean) => {
      if (!cardId) return;
      setBinLoading(true);
      setBinError(null);
      setCachedNotice(null);
      const { data, error } = await supabase.functions.invoke<CardFetchResponse>(
        "market-comps-card-fetch",
        {
          body: { pokemon_card_image_id: cardId, force },
        },
      );
      if (error) {
        setBinError(error.message);
        setBinLoading(false);
        return;
      }
      const payload = data as CardFetchResponse | null;
      if (payload?.error) {
        setBinError(payload.error);
        setBinLoading(false);
        return;
      }
      if (!payload?.ok) {
        setBinError("Unexpected response from server");
        setBinLoading(false);
        return;
      }
      setBinRows((payload.rows ?? []) as BinRow[]);
      setFetchedMeta({
        fetchedAt: payload.fetchedAt ?? null,
        cached: Boolean(payload.cached),
      });
      if (payload.cached) {
        const m = payload.cooldownMinutes ?? 15;
        setCachedNotice(`Using cached results (refresh allowed every ${m} minutes unless you choose Refresh).`);
      }
      const errs = payload.errors?.filter(Boolean);
      if (errs && errs.length > 0 && !(payload.rows && payload.rows.length > 0)) {
        setBinError(errs.join("; "));
      }
      setBinLoading(false);
    },
    [cardId],
  );

  useEffect(() => {
    void loadCardAndSold();
  }, [loadCardAndSold]);

  useEffect(() => {
    if (!cardId || !session) return;
    void fetchBinComps(false);
  }, [cardId, session, fetchBinComps]);

  const binByFinish = useMemo(() => {
    const m: Record<string, BinRow> = {};
    for (const r of binRows) {
      m[r.card_type] = r;
    }
    return m;
  }, [binRows]);

  const maxAvgCents = useMemo(() => {
    let m = 0;
    for (const f of COMP_FINISH_ORDER) {
      const v = binByFinish[f]?.average_price_cents;
      if (v != null && v > m) m = v;
    }
    return m || 1;
  }, [binByFinish]);

  if (!url || !anon) {
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
                <img src={card.image_url} alt={card.name} />
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

          <section className="card-detail-section">
            <h3>Market overview</h3>
            <p className="text-muted text-sm">
              Sold comps from eBay (Finding API) and TCGplayer subtype prices — same as the catalog grid.
            </p>
            <table className="market-pricing-table card-detail-market-table">
              <thead>
                <tr>
                  <th scope="col">Finish</th>
                  <th scope="col">eBay sold</th>
                  <th scope="col">TCGplayer</th>
                </tr>
              </thead>
              <tbody>
                {COMP_FINISH_ORDER.map((finish) => {
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
                })}
              </tbody>
            </table>
          </section>

          <section className="card-detail-section card-detail-bin">
            <div className="card-detail-bin-header">
              <h3>Buy It Now on eBay</h3>
              <button
                type="button"
                className="secondary"
                disabled={binLoading}
                onClick={() => void fetchBinComps(true)}
              >
                {binLoading ? "Refreshing…" : "Refresh listings"}
              </button>
            </div>
            <p className="text-muted text-sm">
              Averages come from search-derived Buy It Now listings; they are not a guaranteed checkout price.
            </p>

            {cachedNotice && (
              <p className="text-muted text-sm" role="status">
                {cachedNotice}
              </p>
            )}

            <div className="card-detail-chart-wrap" aria-busy={binLoading}>
              {binLoading && (
                <div className="card-detail-chart-skeleton" aria-live="polite">
                  <div className="card-detail-chart-skeleton-bars" aria-hidden>
                    <div className="card-detail-chart-skeleton-bar" />
                    <div className="card-detail-chart-skeleton-bar" />
                    <div className="card-detail-chart-skeleton-bar" />
                  </div>
                  <p className="card-detail-chart-loading-msg">
                    Fetching Buy It Now listings from eBay…
                  </p>
                </div>
              )}

              {!binLoading && binError && (
                <p className="error">
                  {binError}{" "}
                  <button type="button" className="secondary" onClick={() => void fetchBinComps(false)}>
                    Retry
                  </button>
                </p>
              )}

              {!binLoading && !binError && fetchedMeta && (
                <>
                  <div className="card-detail-chart">
                    {COMP_FINISH_ORDER.map((finish) => {
                      const row = binByFinish[finish];
                      const avg = row?.average_price_cents;
                      const hPct = avg != null && maxAvgCents > 0
                        ? Math.round((avg / maxAvgCents) * 100)
                        : 0;
                      return (
                        <div key={finish} className="card-detail-chart-col">
                          <div
                            className="card-detail-chart-bar"
                            style={{ height: `${Math.max(8, hPct)}%` }}
                            title={avg != null ? fmtCents(avg) : "No data"}
                          />
                          <span className="card-detail-chart-label">{finish}</span>
                          <span className="tabular-nums card-detail-chart-value">
                            {fmtCents(avg)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-muted text-sm card-detail-asof">
                    Results as of{" "}
                    {fetchedMeta.fetchedAt
                      ? `${formatRelativeAgo(fetchedMeta.fetchedAt)} (${new Date(fetchedMeta.fetchedAt).toLocaleString()})`
                      : "—"}
                    . Prices and links reflect that search; listings may sell or end before you open them.
                  </p>
                  <ul className="card-detail-bin-links">
                    {COMP_FINISH_ORDER.map((finish) => {
                      const row = binByFinish[finish];
                      if (!row?.listing_url) return null;
                      return (
                        <li key={finish}>
                          <a
                            href={row.listing_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            View sample listing ({finish})
                          </a>
                          {uniqueRecentPrices(row.price_cents_history, 5).length > 0 && (
                            <span className="text-muted text-sm">
                              {" "}
                              Recent prices used:{" "}
                              {uniqueRecentPrices(row.price_cents_history, 5)
                                .map((c) => fmtCents(c))
                                .join(", ")}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          </section>
        </>
      )}

      {binError && !card && <p className="error">{binError}</p>}
    </div>
  );
}
