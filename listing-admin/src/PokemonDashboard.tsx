import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { applyThemeToDocument, type Theme } from "./theme";
import { tcgplayerActiveFinishes, type TcgFinish } from "./tcgFinishScope";
import {
  fetchListingCatalogStatus,
  LISTING_CATALOG_STATUS_QUERY_KEY,
  type CatalogStatusRow,
} from "./listingCatalogStatus";
import {
  POKEMON_CARDS_PAGE_SIZE,
  EMPTY_POKEMON_CARD_FILTERS,
  fetchPokemonDashboardGrid,
  type PokemonCardImageRow,
  type PokemonCardFilters,
  type DashboardGridQueryResult,
} from "./pokemonDashboardGridFetch";
import { supabase, supabaseAnonKey, supabaseUrl } from "./supabaseClient";

type MarketSoldCompRow = {
  id: string;
  pokemon_card_image_id: string | null;
  card_type: string;
  average_price_cents: number | null;
  sample_size: number;
  updated_at: string;
};

/** When no catalog filters are applied, pagination UI is limited to this many pages. */
const MAX_DASHBOARD_PAGES_UNFILTERED = 50;
/** Column headers = marketplace (BIN comps live on card detail page only). */
const MARKETPLACE_COLUMNS = [
  { id: "ebay-sold" as const, label: "eBay sold" },
  { id: "tcgplayer" as const, label: "TCGplayer" },
] as const;

const SHOW_EBAY_CONNECTION = false;

const SHOW_REFRESH_CATALOG_BUTTON = false;

function ilikeContainsPattern(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const safe = t.replace(/[%_\\]/g, "");
  if (!safe) return null;
  return `%${safe}%`;
}

type ReleaseSortRow = { name: string; t: number | null };

/**
 * Series / set filter dropdowns: by max `set_release_date` (newest first), then name.
 * `sort_newest` comes from RPC; when missing or all null, order is A–Z (re-ingest + Edge deploy needed for dates).
 */
/** Series RPC returns `series`, optional `display_name` (TCGdex), `sort_newest`. */
function seriesFilterRowsFromRpc(data: unknown): { series: string; label: string }[] {
  if (data == null || !Array.isArray(data)) return [];
  const rows: { series: string; label: string; t: number | null }[] = [];
  for (const item of data) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const seriesRaw = o.series;
      const displayRaw = o.display_name;
      const dRaw = o.sort_newest;
      if (typeof seriesRaw !== "string" || !seriesRaw.trim()) continue;
      const series = seriesRaw.trim();
      const label =
        typeof displayRaw === "string" && displayRaw.trim()
          ? displayRaw.trim()
          : series;
      let t: number | null = null;
      if (dRaw != null && dRaw !== "") {
        const time = new Date(String(dRaw)).getTime();
        t = Number.isNaN(time) ? null : time;
      }
      rows.push({ series, label, t });
    }
  }
  rows.sort((a, b) => {
    if (a.t == null && b.t == null) return a.series.localeCompare(b.series);
    if (a.t == null) return 1;
    if (b.t == null) return -1;
    if (b.t !== a.t) return b.t - a.t;
    return a.series.localeCompare(b.series);
  });
  return rows.map(({ series, label }) => ({ series, label }));
}

function filterOptionsByReleaseDate(
  data: unknown,
  nameKey: "series" | "card_set",
): string[] {
  if (data == null || !Array.isArray(data)) return [];
  const rows: ReleaseSortRow[] = [];
  for (const item of data) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const n = o[nameKey];
      const dRaw = o.sort_newest;
      if (typeof n !== "string" || !n.trim()) continue;
      let t: number | null = null;
      if (dRaw != null && dRaw !== "") {
        const time = new Date(String(dRaw)).getTime();
        t = Number.isNaN(time) ? null : time;
      }
      rows.push({ name: n.trim(), t });
    } else if (typeof item === "string" && item.trim()) {
      rows.push({ name: item.trim(), t: null });
    }
  }
  rows.sort((a, b) => {
    if (a.t == null && b.t == null) return a.name.localeCompare(b.name);
    if (a.t == null) return 1;
    if (b.t == null) return -1;
    if (b.t !== a.t) return b.t - a.t;
    return a.name.localeCompare(b.name);
  });
  return rows.map((r) => r.name);
}

/** Collector number as printed: `107/88`; normalizes spacing if stored as `107 / 88`. */
function formatCardNumberDisplay(n: string | null | undefined): string {
  if (n == null) return "—";
  const t = n.trim();
  if (!t) return "—";
  const m = t.match(/^(\d{1,4})\s*\/\s*(\d{1,4})$/);
  if (m) return `${m[1]}/${m[2]}`;
  return t;
}

/** Signed TCGplayer snapshot delta (latest ingest vs previous). */
function fmtTcgplayerDelta(cents: number | null): string {
  if (cents == null) return "—";
  const sign = cents > 0 ? "+" : "";
  return `${sign}$${(cents / 100).toFixed(2)}`;
}

function tcgplayerDeltaToneClass(cents: number | null): string {
  if (cents == null) return "tcgplayer-delta-na";
  if (cents > 0) return "tcgplayer-delta-up";
  if (cents < 0) return "tcgplayer-delta-down";
  return "tcgplayer-delta-flat";
}

function fmtCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** Relative age from an ISO timestamp (e.g. catalog refresh, comps). */
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

function compKey(pokemonId: string, cardType: string): string {
  return `${pokemonId}::${cardType}`;
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

function tcgDeltaCentsForFinish(
  row: PokemonCardImageRow,
  finish: TcgFinish,
): number | null {
  switch (finish) {
    case "Normal":
      return row.tcgplayer_delta_normal_cents;
    case "Holo":
      return row.tcgplayer_delta_holo_cents;
    case "Reverse Holo":
      return row.tcgplayer_delta_reverse_holo_cents;
    default:
      return null;
  }
}

function tcgDeltaFinishLabel(finish: TcgFinish): string {
  return finish === "Reverse Holo" ? "Rev Holo" : finish;
}

type PokemonIngestResponse = {
  ok?: boolean;
  partial?: boolean;
  done?: boolean;
  nextStartGroupIndex?: number | null;
  rowsUpserted?: number;
  startGroupIndex?: number;
  endGroupIndex?: number;
  totalGroups?: number;
  errors?: string[];
};

export type PokemonDashboardProps = {
  session: Session;
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  onSignOut: () => void | Promise<void>;
};

export default function PokemonDashboard({
  session,
  theme,
  setTheme,
  onSignOut,
}: PokemonDashboardProps) {
  const queryClient = useQueryClient();
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  /** Stable id so effects do not re-run on JWT refresh (new `session` object, same user). */
  const sessionUserId = session?.user?.id;
  const [error, setError] = useState<string | null>(null);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [oauthTabPending, setOauthTabPending] = useState(false);
  const [pokemonCardsPage, setPokemonCardsPage] = useState(1);
  const [pokemonCardFilters, setPokemonCardFilters] = useState<PokemonCardFilters>(
    () => ({ ...EMPTY_POKEMON_CARD_FILTERS }),
  );
  const pokemonCardFiltersRef = useRef(pokemonCardFilters);
  pokemonCardFiltersRef.current = pokemonCardFilters;
  const pokemonCardsPageRef = useRef(pokemonCardsPage);
  pokemonCardsPageRef.current = pokemonCardsPage;
  const gridQueryDataRef = useRef<DashboardGridQueryResult | undefined>(undefined);
  const pendingListingCatalogMetaRef = useRef<Partial<CatalogStatusRow> | null>(null);
  const [frozenGridSnapshot, setFrozenGridSnapshot] = useState<DashboardGridQueryResult | null>(
    null,
  );
  const hotSoldRefreshSentRef = useRef(false);
  const [pokemonIngestBusy, setPokemonIngestBusy] = useState(false);
  const [pokemonIngestStatus, setPokemonIngestStatus] = useState("");
  const [soldCompsByKey, setSoldCompsByKey] = useState<
    Record<string, MarketSoldCompRow>
  >({});
  const [cardSetOptions, setCardSetOptions] = useState<string[]>([]);
  const [cardSetOptionsLoading, setCardSetOptionsLoading] = useState(false);
  /** Per-cell expand: e.g. `${cardId}::${finish}::ebay-listed` */
  const [compBreakdownOpen, setCompBreakdownOpen] = useState<Record<string, boolean>>({});
  /** Bumps on an interval so “Xm ago” labels stay current (re-render only). */
  const [, setCompsTimeTick] = useState(0);

  /** Fetches set names for a series. Call when the user picks a series. */
  const loadCardSetsForSeries = useCallback(
    async (series: string): Promise<string[] | null> => {
      if (!session) return null;
      const t = series.trim();
      if (!t) {
        setCardSetOptions([]);
        setCardSetOptionsLoading(false);
        return [];
      }
      setCardSetOptionsLoading(true);
      setCardSetOptions([]);
      const { data, error: e } = await supabase.rpc("list_distinct_pokemon_card_sets_for_series", {
        p_series: t,
      });
      if (e) {
        setError(e.message);
        setCardSetOptionsLoading(false);
        return null;
      }
      const setNames = filterOptionsByReleaseDate(data, "card_set");
      setCardSetOptions(setNames);
      setCardSetOptionsLoading(false);
      return setNames;
    },
    [session],
  );

  const updatePokemonCardFilter = useCallback(
    <K extends keyof PokemonCardFilters>(key: K, value: string) => {
      setPokemonCardFilters((prev) => ({ ...prev, [key]: value }));
      setPokemonCardsPage(1);
    },
    [],
  );

  const updatePokemonSeriesFilter = useCallback(
    (value: string) => {
      setPokemonCardFilters((prev) => ({ ...prev, series: value, card_set: "" }));
      setPokemonCardsPage(1);
      void loadCardSetsForSeries(value);
    },
    [loadCardSetsForSeries],
  );

  const toggleCompBreakdown = useCallback((key: string) => {
    setCompBreakdownOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const fetchSoldMarketCompsForIds = useCallback(
    async (ids: string[]): Promise<Record<string, MarketSoldCompRow> | null> => {
      if (ids.length === 0) return {};
      const { data, error: e } = await supabase
        .from("market_sold_comps")
        .select("id, pokemon_card_image_id, card_type, average_price_cents, sample_size, updated_at")
        .in("pokemon_card_image_id", ids);

      if (e) {
        setError(e.message);
        return null;
      }
      const next: Record<string, MarketSoldCompRow> = {};
      for (const row of (data ?? []) as MarketSoldCompRow[]) {
        const pid = row.pokemon_card_image_id;
        if (!pid) continue;
        next[compKey(pid, row.card_type)] = row;
      }
      return next;
    },
    [],
  );

  const fetchHotMoverCardIds = useCallback(async (): Promise<string[] | null> => {
    const { data, error: e } = await supabase
      .from("dashboard_hot_movers")
      .select("pokemon_card_image_id")
      .order("rank", { ascending: true });
    if (e) return null;
    return (data ?? [])
      .map((r) => {
        const id = (r as { pokemon_card_image_id?: string }).pokemon_card_image_id;
        return typeof id === "string" ? id : null;
      })
      .filter((id): id is string => Boolean(id));
  }, []);

  const gridQueryKeyFor = useCallback(
    (page: number, filters: PokemonCardFilters, generation: number | null) => [
      "pokemon-dashboard-grid",
      generation ?? "ungated",
      page,
      filters,
    ] as const,
    [],
  );

  const catalogStatusQuery = useQuery({
    queryKey: LISTING_CATALOG_STATUS_QUERY_KEY,
    enabled: Boolean(sessionUserId),
    refetchOnWindowFocus: false,
    queryFn: fetchListingCatalogStatus,
  });

  const catalogGeneration = catalogStatusQuery.data?.generation ?? null;
  const ingestRunning = catalogStatusQuery.data?.ingest_running ?? false;

  const seriesQuery = useQuery({
    queryKey: ["pokemon-dashboard-series-options"],
    enabled: Boolean(sessionUserId),
    staleTime: 1000 * 60 * 30,
    queryFn: async () => {
      const { data, error: e } = await supabase.rpc("list_distinct_pokemon_series");
      if (e) throw e;
      return seriesFilterRowsFromRpc(data);
    },
  });

  const seriesFilterRows = seriesQuery.data ?? [];
  const pokemonFilterBootstrapped = seriesQuery.isFetched;

  const hotIdsQuery = useQuery({
    queryKey: ["pokemon-dashboard-hot-ids", catalogGeneration ?? "ungated"],
    queryFn: async () => (await fetchHotMoverCardIds()) ?? [],
    staleTime: 1000 * 60 * 5,
    enabled: Boolean(sessionUserId),
  });

  const gridQuery = useQuery({
    queryKey: gridQueryKeyFor(pokemonCardsPage, pokemonCardFilters, catalogGeneration),
    enabled: Boolean(sessionUserId),
    staleTime: 1000 * 60 * 5,
    queryFn: () =>
      fetchPokemonDashboardGrid({
        page: pokemonCardsPage,
        filters: pokemonCardFilters,
        hotIds: hotIdsQuery.data ?? [],
      }),
  });

  const visibleGridData: DashboardGridQueryResult | undefined =
    frozenGridSnapshot !== null ? frozenGridSnapshot : (gridQuery.data ?? undefined);

  const soldCompsQuery = useQuery({
    queryKey: [
      "pokemon-dashboard-sold-comps",
      catalogGeneration ?? "ungated",
      (visibleGridData?.rows ?? []).map((r) => r.id).join(","),
    ],
    enabled: Boolean(sessionUserId && (visibleGridData?.rows?.length ?? 0) > 0),
    staleTime: 60_000,
    queryFn: async () => {
      const ids = (visibleGridData?.rows ?? []).map((r) => r.id);
      return (await fetchSoldMarketCompsForIds(ids)) ?? {};
    },
  });

  const loadPokemonCards = useCallback(async (_opts?: { silent?: boolean }) => {
    await gridQuery.refetch();
    await soldCompsQuery.refetch();
  }, [
    gridQuery,
    soldCompsQuery,
  ]);

  const loadPokemonCardsRef = useRef(loadPokemonCards);
  loadPokemonCardsRef.current = loadPokemonCards;
  const ingestRunningRef = useRef(false);

  const prefetchDashboardQueries = useCallback(async () => {
    const status = queryClient.getQueryData<CatalogStatusRow | null>(
      LISTING_CATALOG_STATUS_QUERY_KEY,
    );
    const gen = status?.generation ?? null;
    await queryClient.prefetchQuery({
      queryKey: ["pokemon-dashboard-hot-ids", gen ?? "ungated"],
      queryFn: async () => (await fetchHotMoverCardIds()) ?? [],
      staleTime: 1000 * 60 * 5,
    });
    const hotIds =
      queryClient.getQueryData<string[]>(["pokemon-dashboard-hot-ids", gen ?? "ungated"]) ?? [];
    await queryClient.prefetchQuery({
      queryKey: gridQueryKeyFor(pokemonCardsPageRef.current, pokemonCardFiltersRef.current, gen),
      queryFn: () =>
        fetchPokemonDashboardGrid({
          page: pokemonCardsPageRef.current,
          filters: pokemonCardFiltersRef.current,
          hotIds,
        }),
      staleTime: 1000 * 60 * 5,
    });
  }, [queryClient, fetchHotMoverCardIds, gridQueryKeyFor]);

  useEffect(() => {
    ingestRunningRef.current = ingestRunning;
  }, [ingestRunning]);

  useEffect(() => {
    gridQueryDataRef.current = gridQuery.data;
  }, [gridQuery.data]);

  useEffect(() => {
    setFrozenGridSnapshot(null);
  }, [pokemonCardsPage, pokemonCardFilters]);

  useEffect(() => {
    const p = pendingListingCatalogMetaRef.current;
    if (!p) return;
    if (p.generation === undefined && p.ingest_running === undefined) return;
    queryClient.setQueryData<CatalogStatusRow | null>(
      LISTING_CATALOG_STATUS_QUERY_KEY,
      (old) => {
        const base = old ?? { generation: 0, ingest_running: false };
        return {
          generation: typeof p.generation === "number" ? p.generation : base.generation,
          ingest_running:
            typeof p.ingest_running === "boolean" ? p.ingest_running : base.ingest_running,
        };
      },
    );
    pendingListingCatalogMetaRef.current = null;
  }, [pokemonCardsPage, pokemonCardFilters, queryClient]);

  useEffect(() => {
    if (seriesQuery.error) setError((seriesQuery.error as Error).message);
  }, [seriesQuery.error]);

  useEffect(() => {
    if (!sessionUserId) return;
    const ids = hotIdsQuery.data ?? [];
    if (ids.length === 0) return;
    if (hotSoldRefreshSentRef.current) return;
    hotSoldRefreshSentRef.current = true;
    void (async () => {
      const {
        data: { session: s },
      } = await supabase.auth.getSession();
      if (!s) return;
      try {
        await fetch(
          `${supabaseUrl.replace(/\/$/, "")}/functions/v1/market-sold-comps-hot-refresh`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${s.access_token}`,
              apikey: supabaseAnonKey,
            },
            body: JSON.stringify({ pokemon_card_image_ids: ids }),
          },
        );
      } catch {
        /* ignore */
      }
    })();
  }, [sessionUserId, hotIdsQuery.data]);

  const loadSafeAccount = useCallback(async () => {
    const { data } = await supabase.from("lp_ebay_accounts_safe").select("*").maybeSingle();
    if (data && typeof data === "object") {
      const row = data as Record<string, unknown>;
      setEbayConnected(!!row.has_refresh_token);
      if (row.has_refresh_token) setOauthTabPending(false);
    } else {
      setEbayConnected(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setCompsTimeTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!SHOW_EBAY_CONNECTION) return;
    if (!session) return;
    void loadSafeAccount();
  }, [session, loadSafeAccount]);

  useEffect(() => {
    if (gridQuery.error) setError((gridQuery.error as Error).message);
  }, [gridQuery.error]);

  useEffect(() => {
    if (soldCompsQuery.error) setError((soldCompsQuery.error as Error).message);
  }, [soldCompsQuery.error]);

  useEffect(() => {
    if (!soldCompsQuery.data) return;
    setSoldCompsByKey(soldCompsQuery.data);
  }, [soldCompsQuery.data]);

  const pokemonCards = visibleGridData?.rows ?? [];
  const pokemonCardsTotal = visibleGridData?.total ?? 0;
  const catalogAwaitingFirstPaint =
    gridQuery.isPending && frozenGridSnapshot === null && gridQuery.data === undefined;
  const filterOptionsLoading = seriesQuery.isPending;
  useEffect(() => {
    setCompBreakdownOpen({});
  }, [pokemonCardsPage, pokemonCardFilters, catalogGeneration]);

  /** market_rss_cards: prefetch fresh grid/hot data without swapping the frozen on-screen snapshot. */
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (ingestRunningRef.current) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        const snap = gridQueryDataRef.current;
        setFrozenGridSnapshot((prev) => prev ?? snap ?? null);
        void prefetchDashboardQueries();
      }, 2500);
    };
    const ch = supabase
      .channel("market_rss_cards_comps")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "market_rss_cards" },
        schedule,
      )
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      void supabase.removeChannel(ch);
    };
  }, [queryClient, prefetchDashboardQueries]);

  /** Sold comps are cell-only updates; keep card ordering + filters unchanged. */
  useEffect(() => {
    const ch = supabase
      .channel("market_sold_comps_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "market_sold_comps" },
        async () => {
          const ids = pokemonCards.map((r) => r.id);
          const soldMap = await fetchSoldMarketCompsForIds(ids);
          if (soldMap != null) setSoldCompsByKey(soldMap);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [pokemonCards, fetchSoldMarketCompsForIds]);

  useEffect(() => {
    const ch = supabase
      .channel("listing_catalog_meta_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "listing_catalog_meta" },
        (payload) => {
          const next = payload.new as
            | { tcgcsv_ingest_running?: boolean; tcgcsv_catalog_generation?: number }
            | undefined;
          if (!next) return;
          pendingListingCatalogMetaRef.current = {
            ...(pendingListingCatalogMetaRef.current ?? {}),
            ...(typeof next.tcgcsv_catalog_generation === "number"
              ? { generation: next.tcgcsv_catalog_generation }
              : {}),
            ...(typeof next.tcgcsv_ingest_running === "boolean"
              ? { ingest_running: next.tcgcsv_ingest_running }
              : {}),
          };
          const wasRunning = ingestRunningRef.current;
          if (typeof next.tcgcsv_ingest_running === "boolean") {
            ingestRunningRef.current = next.tcgcsv_ingest_running;
          }
          if (
            wasRunning &&
            typeof next.tcgcsv_ingest_running === "boolean" &&
            !next.tcgcsv_ingest_running
          ) {
            const snap = gridQueryDataRef.current;
            setFrozenGridSnapshot((prev) => prev ?? snap ?? null);
            void queryClient.invalidateQueries({
              queryKey: ["pokemon-dashboard-series-options"],
            });
            void prefetchDashboardQueries();
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [queryClient, prefetchDashboardQueries]);

  const pokemonFiltersActive = useMemo(
    () => Object.values(pokemonCardFilters).some((v) => v.trim() !== ""),
    [pokemonCardFilters],
  );

  const nameSearchSpansCatalog = useMemo(
    () => ilikeContainsPattern(pokemonCardFilters.name) != null,
    [pokemonCardFilters.name],
  );

  /** True when the current pick matches the top option in each dropdown (newest series + newest set in it). */
  const filtersMatchNewestByRelease = useMemo(() => {
    if (seriesFilterRows.length === 0) return false;
    if (pokemonCardFilters.series !== seriesFilterRows[0]!.series) return false;
    if (cardSetOptions.length === 0) return false;
    return pokemonCardFilters.card_set === cardSetOptions[0];
  }, [seriesFilterRows, cardSetOptions, pokemonCardFilters.series, pokemonCardFilters.card_set]);

  const pokemonCardsTotalPages = useMemo(() => {
    const uncapped = Math.max(
      1,
      Math.ceil(pokemonCardsTotal / POKEMON_CARDS_PAGE_SIZE),
    );
    if (pokemonFiltersActive) return uncapped;
    return Math.min(uncapped, MAX_DASHBOARD_PAGES_UNFILTERED);
  }, [pokemonFiltersActive, pokemonCardsTotal]);

  const pokemonCardsPageSafe = Math.min(pokemonCardsPage, pokemonCardsTotalPages);

  useEffect(() => {
    setPokemonCardsPage((p) => Math.min(p, pokemonCardsTotalPages));
  }, [pokemonCardsTotalPages]);

  useEffect(() => {
    if (!oauthTabPending) return;
    const id = window.setInterval(() => void loadSafeAccount(), 2000);
    const onFocus = () => void loadSafeAccount();
    window.addEventListener("focus", onFocus);
    const maxWait = window.setTimeout(() => setOauthTabPending(false), 10 * 60_000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(maxWait);
      window.removeEventListener("focus", onFocus);
    };
  }, [oauthTabPending, loadSafeAccount]);

  async function refreshPokemonCatalog() {
    setError(null);
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s) {
      setError("Sign in first");
      return;
    }

    const base = supabaseUrl.replace(/\/$/, "");
    const fnUrl = `${base}/functions/v1/pokemon-card-images-ingest`;

    setPokemonIngestBusy(true);
    setPokemonIngestStatus("");
    let startGroupIndex = 0;
    let batch = 0;
    let totalRows = 0;
    const warningNotes: string[] = [];

    try {
      for (;;) {
        batch += 1;
        const res = await fetch(fnUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${s.access_token}`,
          },
          body: JSON.stringify({ startGroupIndex }),
        });
        const text = await res.text();
        let parsed: PokemonIngestResponse;
        try {
          parsed = JSON.parse(text) as PokemonIngestResponse;
        } catch {
          setError(`Catalog refresh failed (${res.status}). ${text.slice(0, 200)}`);
          return;
        }
        if (!res.ok) {
          const msg =
            parsed.errors?.join("; ") ??
            (typeof (parsed as { message?: string }).message === "string"
              ? (parsed as { message: string }).message
              : null) ??
            `Catalog refresh failed (${res.status})`;
          setError(msg);
          return;
        }

        if (parsed.partial && parsed.errors?.length) {
          for (const e of parsed.errors) {
            if (!warningNotes.includes(e)) warningNotes.push(e);
          }
        }

        totalRows += parsed.rowsUpserted ?? 0;
        setPokemonIngestStatus(
          `Batch ${batch}: ${parsed.rowsUpserted ?? 0} rows (groups ${parsed.startGroupIndex ?? "?"}–${
            parsed.endGroupIndex ?? "?"
            } of ${parsed.totalGroups ?? "?"})…`,
        );

        if (parsed.done === true) break;
        const next = parsed.nextStartGroupIndex;
        if (next == null || next < 0) break;
        startGroupIndex = next;
      }

      const warnSuffix =
        warningNotes.length > 0
          ? ` Some tcgcsv groups reported errors (${warningNotes.length}); details in browser console.`
          : "";
      if (warningNotes.length > 0) {
        console.warn("[catalog ingest] group warnings:", warningNotes);
      }

      setPokemonIngestStatus(
        `Finished ${batch} batch(es), ~${totalRows} row upserts. The list updates automatically.${warnSuffix}`,
      );
      setFrozenGridSnapshot(null);
      void queryClient.invalidateQueries({ queryKey: ["pokemon-dashboard-series-options"] });
      void queryClient.invalidateQueries({ queryKey: LISTING_CATALOG_STATUS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["pokemon-dashboard-grid"] });
      void queryClient.invalidateQueries({ queryKey: ["pokemon-dashboard-hot-ids"] });
      void loadCardSetsForSeries(pokemonCardFiltersRef.current.series);
      void loadPokemonCards();
    } finally {
      setPokemonIngestBusy(false);
    }
  }

  async function connectEbay() {
    setError(null);
    const { data: { session: s } } = await supabase.auth.getSession();
    if (!s) {
      setError("Sign in first");
      return;
    }
    const { data, error: fnErr, response } = await supabase.functions.invoke<{
      url?: string;
      error?: string;
    }>("ebay-oauth-start", { method: "POST" });
    if (fnErr) {
      let msg = fnErr.message;
      if (response) {
        const t = await response.text();
        if (t) {
          try {
            const j = JSON.parse(t) as { error?: string; msg?: string };
            msg = j.error ?? j.msg ?? t;
          } catch {
            msg = t;
          }
        }
      }
      setError(msg);
      return;
    }
    if (!data?.url) return;
    const tab = window.open(data.url, "_blank", "noopener,noreferrer");
    if (!tab) {
      setError("Popup blocked — allow popups for this site, or try again.");
      return;
    }
    setOauthTabPending(true);
    void loadSafeAccount();
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return (
      <p className="error">
        Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY for this app.
      </p>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">Pokemon Cards</h1>
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

      {SHOW_EBAY_CONNECTION && (
        <section>
          <h2>eBay connection</h2>
          {ebayConnected ? (
            <p className="ebay-connected">eBay account connected.</p>
          ) : (
            <>
              <button type="button" onClick={() => void connectEbay()}>
                Connect eBay account
              </button>
              {oauthTabPending && (
                <p className="text-muted text-sm" style={{ marginTop: "0.5rem" }}>
                  Finish signing in with eBay in the new tab, then close it. This page updates
                  automatically when the connection succeeds.
                </p>
              )}
            </>
          )}
          <p className="text-muted text-sm" style={{ marginTop: "0.5rem" }}>
            Active listing comps use the Browse API (<code>EBAY_APP_ID</code> +{" "}
            <code>EBAY_CERT_ID</code>). Sold comps use the Finding API with App ID only (see{" "}
            <code>market-sold-comps-ingest</code>).
          </p>
        </section>
      )}

      <section className="section-spaced">
        {SHOW_REFRESH_CATALOG_BUTTON && (
          <div className="ingest-actions">
            <button
              type="button"
              disabled={pokemonIngestBusy}
              onClick={() => void refreshPokemonCatalog()}
            >
              {pokemonIngestBusy
                ? "Refreshing catalog…"
                : "Refresh catalog from tcgcsv (TCGPlayer)"}
            </button>
            {pokemonIngestStatus && (
              <p className="ingest-status">{pokemonIngestStatus}</p>
            )}
          </div>
        )}
        <div className="pokemon-dashboard-filters">
        <h3>Filters</h3>
        <p className="text-muted text-sm">
          Catalog generation: {catalogGeneration ?? "unknown"}{" "}
          {ingestRunning ? "(ingest running)" : ""}
        </p>
        <p className="filter-intro">
          {filtersMatchNewestByRelease ? (
            <>
              Default view is{" "}
              <strong>
                {seriesFilterRows.find((r) => r.series === pokemonCardFilters.series)?.label ??
                  pokemonCardFilters.series}
              </strong>{" "}
              /{" "}
              <strong>{pokemonCardFilters.card_set}</strong> (newest series, then newest set in that
              series, by <strong>set release date</strong> in your catalog), sorted by collector
              number.{" "}
            </>
          ) : (
            <>
              Series and set are listed newest-to-oldest by <strong>set release date</strong> (per
              series, then per set in a series). Pick a series and set to browse one print run by
              collector number; leave them unset to browse or search the full catalog.{" "}
            </>
          )}
          Choose another series, then set, to browse a different print run the same way. Use{" "}
          <strong>Clear filters</strong> to search the full catalog.
        </p>
        {nameSearchSpansCatalog && (
          <p className="filter-intro filter-name-global-hint">
            Name search runs across the whole catalog; Series and Set are ignored until you clear the
            name.
          </p>
        )}
        <div className="filter-grid">
          <div>
            <label>Name</label>
            <input
              value={pokemonCardFilters.name}
              onChange={(e) => updatePokemonCardFilter("name", e.target.value)}
              placeholder="Card name"
              autoComplete="off"
            />
          </div>
          <div>
            <label>Series</label>
            <select
              value={pokemonCardFilters.series}
              disabled={!pokemonFilterBootstrapped}
              onChange={(e) => updatePokemonSeriesFilter(e.target.value)}
              aria-label="Series (required for set list)"
            >
              <option value="" disabled>
                {seriesFilterRows.length === 0 ? "Loading series…" : "Select a series"}
              </option>
              {seriesFilterRows.map((r) => (
                <option key={r.series} value={r.series}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Set</label>
            <select
              value={pokemonCardFilters.card_set}
              disabled={
                !pokemonFilterBootstrapped ||
                !pokemonCardFilters.series.trim() ||
                cardSetOptionsLoading
              }
              title={
                !pokemonCardFilters.series.trim()
                  ? "Choose a series first to load sets"
                  : cardSetOptionsLoading
                    ? "Loading sets for this series…"
                    : undefined
              }
              onChange={(e) => updatePokemonCardFilter("card_set", e.target.value)}
              aria-busy={cardSetOptionsLoading}
            >
              <option value="">
                {!pokemonCardFilters.series.trim()
                  ? "Choose a series first"
                  : cardSetOptionsLoading
                    ? "Loading sets…"
                    : "All sets in series"}
              </option>
              {cardSetOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Card #</label>
            <input
              value={pokemonCardFilters.card_number}
              onChange={(e) => updatePokemonCardFilter("card_number", e.target.value)}
              placeholder="e.g. 4, 102/88"
              autoComplete="off"
            />
          </div>
          <div className="filter-actions">
            <button
              type="button"
              className="secondary"
              disabled={!pokemonFiltersActive}
              onClick={() => {
                setPokemonCardFilters({ ...EMPTY_POKEMON_CARD_FILTERS });
                setCardSetOptions([]);
                setCardSetOptionsLoading(false);
                setPokemonCardsPage(1);
              }}
            >
              Clear filters
            </button>
          </div>
        </div>
        </div>
        {(filterOptionsLoading || catalogAwaitingFirstPaint) && (
          <div className="text-muted text-sm" style={{ marginBottom: "1rem" }}>
            {filterOptionsLoading && <p>Loading filter options…</p>}
            {catalogAwaitingFirstPaint && <p>Loading catalog…</p>}
          </div>
        )}
        {!catalogAwaitingFirstPaint && visibleGridData !== undefined && (
        <div className="pokemon-card-grid">
          {pokemonCards.map((c) => {
            const finishes = tcgplayerActiveFinishes({
              tcgplayer_prices_by_finish: c.tcgplayer_prices_by_finish,
              tcgplayer_price_cents: c.tcgplayer_price_cents,
            });
            return (
            <article key={c.id} className="pokemon-card">
              <Link
                to={`/card/${c.id}`}
                className="pokemon-card-detail-link"
                aria-label={`Open details for ${c.name}`}
              >
              <div className="pokemon-card-media">
                {c.image_url ? (
                  <img src={c.image_url} alt={c.name} loading="lazy" />
                ) : (
                  <div className="pokemon-card-media--empty">No image</div>
                )}
              </div>
              <h3 className="pokemon-card-title">{c.name}</h3>
              <ul className="pokemon-card-meta">
                <li>
                  <strong>Series:</strong> {c.series ?? "—"}
                </li>
                <li>
                  <strong>Set:</strong> {c.card_set ?? "—"}
                </li>
                <li>
                  <strong>#</strong> {formatCardNumberDisplay(c.card_number)}
                </li>
                <li>
                  <strong>Rarity:</strong> {c.rarity ?? "—"}
                </li>
              </ul>
              <p className="pokemon-card-fetched">
                <time dateTime={c.updated_at} title={c.updated_at}>
                  TCGplayer/catalog: {formatRelativeAgo(c.updated_at)}
                </time>
                <span className="pokemon-card-fetched-sep" aria-hidden>
                  {" "}
                  ·{" "}
                </span>
                {c.last_sold_comp_at ? (
                  <time dateTime={c.last_sold_comp_at} title={c.last_sold_comp_at}>
                    eBay sold comps: {formatRelativeAgo(c.last_sold_comp_at)}
                  </time>
                ) : (
                  <span title="No sold comps for this card yet">eBay sold: —</span>
                )}
              </p>
              </Link>
              <div className="pokemon-card-comps-wrap">
                {finishes.length === 0 ? (
                  <p className="text-muted text-sm">
                    No TCGplayer finish prices — eBay comps are not tracked for this card.
                  </p>
                ) : (
                  <p className="pokemon-card-tcgplayer-delta text-sm" aria-label="TCGplayer price change since last catalog ingest">
                    <span className="text-muted">TCGplayer vs last fetch:</span>{" "}
                    {finishes.map((finish, idx) => (
                      <span key={finish}>
                        {idx > 0 && (
                          <span className="pokemon-card-tcgplayer-delta-sep" aria-hidden>
                            {" "}
                            ·{" "}
                          </span>
                        )}
                        <span
                          className={`pokemon-card-tcgplayer-delta-chip ${tcgplayerDeltaToneClass(tcgDeltaCentsForFinish(c, finish))}`}
                        >
                          {tcgDeltaFinishLabel(finish)}{" "}
                          {fmtTcgplayerDelta(tcgDeltaCentsForFinish(c, finish))}
                        </span>
                      </span>
                    ))}
                  </p>
                )}
                <table className="market-pricing-table">
                  <thead>
                    <tr className="comps-head-row">
                      <th scope="col">Finish</th>
                      {MARKETPLACE_COLUMNS.map((col) => (
                        <th key={col.id} scope="col">
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {finishes.length === 0 ? (
                      <tr className="comps-finish-row">
                        <td colSpan={3} className="text-muted text-sm">
                          No finishes with TCGplayer prices.
                        </td>
                      </tr>
                    ) : (
                      finishes.map((finish) => {
                      const soldRow = soldCompsByKey[compKey(c.id, finish)];
                      const bkSold = `${c.id}::${finish}::ebay-sold`;
                      const bkTcg = `${c.id}::${finish}::tcgplayer`;
                      const soldOpen = !!compBreakdownOpen[bkSold];
                      const tcgOpen = !!compBreakdownOpen[bkTcg];
                      const tcgRaw = c.tcgplayer_prices_by_finish as
                        | Record<string, unknown>
                        | null
                        | undefined;
                      const tcgDetail = tcgcsvPricesForFinish(tcgRaw ?? null, finish);
                      const tcgSummary =
                        tcgPrimaryCents(tcgDetail) ??
                        (finish === "Normal" ? c.tcgplayer_price_cents : null);

                      return (
                        <tr key={finish} className="comps-finish-row">
                          <td>{finish}</td>
                          <td>
                            <div className="comp-metric-cell market-cell-ebay-line">
                              <div className="market-cell-ebay-main">
                                {soldRow ? (
                                  <button
                                    type="button"
                                    className="comp-metric-toggle"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      toggleCompBreakdown(bkSold);
                                    }}
                                    aria-expanded={soldOpen}
                                    aria-label={
                                      soldOpen
                                        ? "Hide sold comp details"
                                        : "Show sold comp details"
                                    }
                                  >
                                    <span className="tabular-nums">
                                      {fmtCents(soldRow.average_price_cents)}
                                    </span>
                                    <span className="comp-metric-chevron" aria-hidden>
                                      {soldOpen ? "▾" : "▸"}
                                    </span>
                                  </button>
                                ) : (
                                  <span className="market-cell-empty">—</span>
                                )}
                              </div>
                              {soldOpen && soldRow && (
                                <ul className="comp-breakdown-list comp-breakdown-list--sold">
                                  <li className="tabular-nums">
                                    Sample size:{" "}
                                    {soldRow.sample_size > 0 ? soldRow.sample_size : "—"}
                                  </li>
                                  <li>
                                    Updated: {formatRelativeAgo(soldRow.updated_at)}
                                  </li>
                                </ul>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="comp-metric-cell">
                              <button
                                type="button"
                                className="comp-metric-toggle"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  toggleCompBreakdown(bkTcg);
                                }}
                                aria-expanded={tcgOpen}
                                aria-label={
                                  tcgOpen
                                    ? "Hide TCGplayer price breakdown"
                                    : "Show TCGplayer price breakdown"
                                }
                              >
                                <span className="tabular-nums">{fmtCents(tcgSummary)}</span>
                                <span className="comp-metric-chevron" aria-hidden>
                                  {tcgOpen ? "▾" : "▸"}
                                </span>
                              </button>
                              {tcgOpen && (
                                <ul className="comp-breakdown-list">
                                  {tcgDetail ? (
                                    <>
                                      <li>Market: {fmtCents(tcgDetail.market_cents)}</li>
                                      <li>Low: {fmtCents(tcgDetail.low_cents)}</li>
                                      <li>High: {fmtCents(tcgDetail.high_cents)}</li>
                                      <li>Direct: {fmtCents(tcgDetail.direct_cents)}</li>
                                    </>
                                  ) : finish === "Normal" && c.tcgplayer_price_cents != null ? (
                                    <li>
                                      Market (catalog): {fmtCents(c.tcgplayer_price_cents)}
                                    </li>
                                  ) : (
                                    <li className="comp-breakdown-empty">No subtype prices yet</li>
                                  )}
                                </ul>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          );
          })}
        </div>
        )}
        {!catalogAwaitingFirstPaint && pokemonCardsTotal > 0 && visibleGridData !== undefined && (
          <div className="pagination-bar">
            <span className="tabular-nums">
              {(pokemonCardsPageSafe - 1) * POKEMON_CARDS_PAGE_SIZE + 1}–
              {Math.min(
                pokemonCardsPageSafe * POKEMON_CARDS_PAGE_SIZE,
                pokemonCardsTotal,
              )}{" "}
              of {pokemonCardsTotal}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={pokemonCardsPageSafe <= 1 || catalogAwaitingFirstPaint || gridQuery.isFetching}
              onClick={() => setPokemonCardsPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            {pokemonCardsTotalPages > 1 ? (
              <label className="pagination-page-inline">
                <span className="tabular-nums">Page</span>
                <select
                  id="pokemon-cards-page"
                  className="pagination-page-select"
                  value={pokemonCardsPageSafe}
                  disabled={catalogAwaitingFirstPaint || gridQuery.isFetching}
                  onChange={(e) => setPokemonCardsPage(Number(e.target.value))}
                  aria-label={`Page, ${pokemonCardsTotalPages} total`}
                >
                  {Array.from({ length: pokemonCardsTotalPages }, (_, i) => i + 1).map(
                    (p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ),
                  )}
                </select>
                <span className="tabular-nums">of {pokemonCardsTotalPages}</span>
              </label>
            ) : (
              <span className="tabular-nums">
                Page {pokemonCardsPageSafe} of {pokemonCardsTotalPages}
              </span>
            )}
            <button
              type="button"
              className="secondary"
              disabled={
                pokemonCardsPageSafe >= pokemonCardsTotalPages ||
                catalogAwaitingFirstPaint ||
                gridQuery.isFetching
              }
              onClick={() =>
                setPokemonCardsPage((p) => Math.min(pokemonCardsTotalPages, p + 1))
              }
            >
              Next
            </button>
          </div>
        )}
        {!catalogAwaitingFirstPaint && pokemonCardsTotal === 0 && visibleGridData !== undefined && (
          <p className="empty-state">
            {pokemonFiltersActive
              ? "No cards match the current filters."
              : SHOW_REFRESH_CATALOG_BUTTON
                ? "No catalog cards yet. Use “Refresh catalog from tcgcsv (TCGPlayer)” above (or run migrations, then refresh)."
                : "No catalog cards yet. Run npm run refresh-pokemon-cards in listing-pipeline (or run migrations, then sync)."}
          </p>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
