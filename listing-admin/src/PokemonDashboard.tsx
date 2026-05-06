import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { createClient, type Session } from "@supabase/supabase-js";
import { applyThemeToDocument, type Theme } from "./theme";

const url = import.meta.env.VITE_SUPABASE_URL ?? "";
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
const supabase = createClient(url, anon);

type PokemonCardImageRow = {
  id: string;
  tcgplayer_product_id: number;
  tcgplayer_price_cents: number | null;
  /** tcgcsv `/prices` rows keyed by subTypeName (see catalog ingest). */
  tcgplayer_prices_by_finish: Record<string, unknown> | null;
  name: string;
  image_url: string | null;
  holo_image_url: string | null;
  reverse_holo_image_url: string | null;
  /** tcgcsv group code prefix (letters before trailing digits), e.g. ME; join pokemon_series_display for label. */
  series: string | null;
  card_set: string | null;
  details: string | null;
  rarity: string | null;
  artist: string | null;
  card_number: string | null;
  created_at: string;
  updated_at: string;
  /** Max `market_rss_cards.updated_at` for this card (all finishes). */
  last_market_comp_at: string | null;
  /** Max `market_sold_comps.updated_at` for this card (all finishes). */
  last_sold_comp_at: string | null;
  /** Largest |avg − previous| among Normal/Holo/Reverse rows for this card. */
  card_max_abs_price_delta_cents: number | null;
  /** Sign of that largest move: 1 = up, −1 = down, 0 = flat (from view). */
  card_price_delta_sign: number | null;
  /** Digits before `/` in card_number for numeric sort (view). */
  card_number_sort_primary: number | null;
  /** Digits after `/` for numeric sort (view). */
  card_number_sort_secondary: number | null;
};

type MarketSoldCompRow = {
  id: string;
  pokemon_card_image_id: string | null;
  card_type: string;
  average_price_cents: number | null;
  sample_size: number;
  updated_at: string;
};

type PokemonCardFilters = {
  name: string;
  series: string;
  card_set: string;
  card_number: string;
  rarity: string;
  artist: string;
};

/** All filters empty (e.g. after “Clear filters”). */
const EMPTY_POKEMON_CARD_FILTERS: PokemonCardFilters = {
  name: "",
  series: "",
  card_set: "",
  card_number: "",
  rarity: "",
  artist: "",
};

const POKEMON_CARDS_PAGE_SIZE = 30;
/** When no catalog filters are applied, pagination UI is limited to this many pages. */
const MAX_DASHBOARD_PAGES_UNFILTERED = 50;
const COMP_FINISH_ORDER = ["Normal", "Holo", "Reverse Holo"] as const;

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

/** PostgREST RPC: `string[]` (setof text) or `{ series?: string }[]` / `{ card_set?: string }[]` (returns table). */
function rpcDistinctStrings(data: unknown): string[] {
  if (data == null) return [];
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const item of data) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push(t);
    } else if (item && typeof item === "object") {
      for (const v of Object.values(item as Record<string, unknown>)) {
        if (typeof v === "string") {
          const t = v.trim();
          if (t) {
            out.push(t);
            break;
          }
        }
      }
    }
  }
  return out;
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

type PokemonIngestResponse = {
  ok?: boolean;
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
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  /** Stable id so effects do not re-run on JWT refresh (new `session` object, same user). */
  const sessionUserId = session?.user?.id;
  const [error, setError] = useState<string | null>(null);
  const [ebayConnected, setEbayConnected] = useState(false);
  const [oauthTabPending, setOauthTabPending] = useState(false);
  const [pokemonCards, setPokemonCards] = useState<PokemonCardImageRow[]>([]);
  const [pokemonCardsTotal, setPokemonCardsTotal] = useState(0);
  const [pokemonCardsPage, setPokemonCardsPage] = useState(1);
  const [pokemonCardFilters, setPokemonCardFilters] = useState<PokemonCardFilters>(
    () => ({ ...EMPTY_POKEMON_CARD_FILTERS }),
  );
  const pokemonCardFiltersRef = useRef(pokemonCardFilters);
  pokemonCardFiltersRef.current = pokemonCardFilters;
  /**
   * After sign-in, apply newest series + newest set in that series (RPCs order by
   * max(set_release_date), newest first) once, then set false. Cleared on sign-out.
   */
  const pokemonCardDefaultsPendingRef = useRef(true);
  /** After false, filter state is valid for the first `loadPokemonCards` (avoids a full-catalog fetch before series RPC completes). */
  const [pokemonFilterBootstrapped, setPokemonFilterBootstrapped] = useState(false);
  const [pokemonCardsLoading, setPokemonCardsLoading] = useState(false);
  const [pokemonIngestBusy, setPokemonIngestBusy] = useState(false);
  const [pokemonIngestStatus, setPokemonIngestStatus] = useState("");
  const [soldCompsByKey, setSoldCompsByKey] = useState<
    Record<string, MarketSoldCompRow>
  >({});
  /** Filter value = `series` (prefix); label from TCGdex when available. */
  const [seriesFilterRows, setSeriesFilterRows] = useState<
    { series: string; label: string }[]
  >([]);
  const [cardSetOptions, setCardSetOptions] = useState<string[]>([]);
  const [cardSetOptionsLoading, setCardSetOptionsLoading] = useState(false);
  const [rarityOptions, setRarityOptions] = useState<string[]>([]);
  /** Per-cell expand: e.g. `${cardId}::${finish}::ebay-listed` */
  const [compBreakdownOpen, setCompBreakdownOpen] = useState<Record<string, boolean>>({});
  /** Bumps on an interval so “Xm ago” labels stay current (re-render only). */
  const [, setCompsTimeTick] = useState(0);

  /** Fetches set names for a series. Call when the user picks a series (or for default bootstrap). */
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

  const loadSeries = useCallback(async () => {
    if (!session) return;
    const { data, error: e } = await supabase.rpc("list_distinct_pokemon_series");
    if (e) {
      setError(e.message);
      setPokemonFilterBootstrapped(true);
      return;
    }
    const seriesRows = seriesFilterRowsFromRpc(data);
    setSeriesFilterRows(seriesRows);
    if (pokemonCardDefaultsPendingRef.current) {
      if (seriesRows.length > 0) {
        const ser = seriesRows[0]!.series;
        const setNames = await loadCardSetsForSeries(ser);
        if (setNames === null) {
          pokemonCardDefaultsPendingRef.current = false;
          setPokemonFilterBootstrapped(true);
          return;
        }
        const set0 = setNames[0] ?? "";
        setPokemonCardFilters({ ...EMPTY_POKEMON_CARD_FILTERS, series: ser, card_set: set0 });
        setPokemonCardsPage(1);
        pokemonCardDefaultsPendingRef.current = false;
      } else {
        pokemonCardDefaultsPendingRef.current = false;
      }
    }
    setPokemonFilterBootstrapped(true);
  }, [session, loadCardSetsForSeries]);

  const loadRarities = useCallback(async () => {
    if (!session) return;
    const { data, error: e } = await supabase.rpc("list_distinct_pokemon_card_rarities");
    if (e) {
      setError(e.message);
      return;
    }
    setRarityOptions(rpcDistinctStrings(data));
  }, [session]);

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

  const loadPokemonCards = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!session) return;
    if (!pokemonFilterBootstrapped) return;
    if (!silent) setPokemonCardsLoading(true);
    try {
      const from = (pokemonCardsPage - 1) * POKEMON_CARDS_PAGE_SIZE;
      const to = from + POKEMON_CARDS_PAGE_SIZE - 1;
      const f = pokemonCardFilters;

      let q = supabase
        .from("pokemon_card_images_with_market_activity")
        .select(
          "id, tcgplayer_product_id, tcgplayer_price_cents, tcgplayer_prices_by_finish, name, image_url, holo_image_url, reverse_holo_image_url, series, card_set, details, rarity, artist, card_number, created_at, updated_at, last_market_comp_at, last_sold_comp_at, card_max_abs_price_delta_cents, card_price_delta_sign, card_number_sort_primary, card_number_sort_secondary",
          { count: "exact" },
        );
      /** Hide catalog rows missing a collector number (null or empty). */
      q = q.not("card_number", "is", null).neq("card_number", "");

      const addIlike = (
        column: keyof Pick<PokemonCardImageRow, "name" | "card_number" | "artist">,
        value: string,
      ) => {
        const pat = ilikeContainsPattern(value);
        if (pat) q = q.ilike(column, pat);
      };

      addIlike("name", f.name);
      const seriesPick = f.series.trim();
      if (seriesPick) q = q.eq("series", seriesPick);
      const setPick = f.card_set.trim();
      if (setPick) q = q.eq("card_set", setPick);
      addIlike("card_number", f.card_number);
      const rarityPick = f.rarity.trim();
      if (rarityPick) q = q.eq("rarity", rarityPick);
      addIlike("artist", f.artist);

      const seriesAndSet = Boolean(seriesPick && setPick);

      let ordered = q;
      if (seriesAndSet) {
        /** Browse a single print set: collector number order (numeric), then stable tie-breaker. */
        ordered = q
          .order("card_number_sort_primary", { ascending: true, nullsFirst: false })
          .order("card_number_sort_secondary", { ascending: true, nullsFirst: false })
          .order("name", { ascending: true });
      } else {
        /** Sold comps recency for default browse (active BIN is on card detail only). */
        ordered = q.order("last_sold_comp_at", {
          ascending: false,
          nullsFirst: false,
        });
        if (setPick) {
          ordered = ordered
            .order("card_number_sort_primary", { ascending: true, nullsFirst: false })
            .order("card_number_sort_secondary", { ascending: true, nullsFirst: false });
        } else {
          ordered = ordered.order("name", { ascending: true });
        }
      }

      const { data, error: e, count } = await ordered.range(from, to);

      if (e) {
        setError(e.message);
        return;
      }
      const rows = (data ?? []) as PokemonCardImageRow[];
      const ids = rows.map((r) => r.id);
      const soldMap = await fetchSoldMarketCompsForIds(ids);
      if (soldMap === null) return;

      setError(null);
      setPokemonCardsTotal(count ?? 0);
      setPokemonCards(rows);
      setSoldCompsByKey(soldMap);
      setCompBreakdownOpen({});
    } finally {
      if (!silent) setPokemonCardsLoading(false);
    }
  }, [
    session,
    pokemonFilterBootstrapped,
    pokemonCardsPage,
    pokemonCardFilters,
    fetchSoldMarketCompsForIds,
  ]);

  const loadPokemonCardsRef = useRef(loadPokemonCards);
  loadPokemonCardsRef.current = loadPokemonCards;
  const loadSeriesRef = useRef(loadSeries);
  loadSeriesRef.current = loadSeries;
  const loadCardSetsForSeriesRef = useRef(loadCardSetsForSeries);
  loadCardSetsForSeriesRef.current = loadCardSetsForSeries;
  const loadRaritiesRef = useRef(loadRarities);
  loadRaritiesRef.current = loadRarities;

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

  /** Load / reload grid when user, filters, or page change — not on every `session` token refresh. */
  useEffect(() => {
    if (!sessionUserId) return;
    if (!pokemonFilterBootstrapped) return;
    void loadPokemonCardsRef.current();
  }, [
    sessionUserId,
    pokemonFilterBootstrapped,
    pokemonCardsPage,
    pokemonCardFilters,
  ]);

  useEffect(() => {
    void loadSeries();
    void loadRarities();
  }, [loadSeries, loadRarities]);

  /** Realtime fires on every row during comps ingest; debounce + silent refresh avoids grid flash. */
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void loadPokemonCardsRef.current({ silent: true });
        void loadSeriesRef.current();
        const ser = pokemonCardFiltersRef.current.series.trim();
        if (ser) void loadCardSetsForSeriesRef.current(ser);
        else {
          setCardSetOptions([]);
          setCardSetOptionsLoading(false);
        }
        void loadRaritiesRef.current();
      }, 2500);
    };
    const ch1 = supabase
      .channel("pokemon_card_images_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pokemon_card_images" },
        schedule,
      )
      .subscribe();
    const ch2 = supabase
      .channel("market_rss_cards_comps")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "market_rss_cards" },
        schedule,
      )
      .subscribe();
    const ch3 = supabase
      .channel("market_sold_comps_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "market_sold_comps" },
        schedule,
      )
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      void supabase.removeChannel(ch1);
      void supabase.removeChannel(ch2);
      void supabase.removeChannel(ch3);
    };
  }, []);

  const pokemonFiltersActive = useMemo(
    () => Object.values(pokemonCardFilters).some((v) => v.trim() !== ""),
    [pokemonCardFilters],
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

    const base = url.replace(/\/$/, "");
    const fnUrl = `${base}/functions/v1/pokemon-card-images-ingest`;

    setPokemonIngestBusy(true);
    setPokemonIngestStatus("");
    let startGroupIndex = 0;
    let batch = 0;
    let totalRows = 0;

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
        if (!res.ok || parsed.ok === false) {
          const msg =
            parsed.errors?.join("; ") ??
            (typeof (parsed as { message?: string }).message === "string"
              ? (parsed as { message: string }).message
              : null) ??
            `Catalog refresh failed (${res.status})`;
          setError(msg);
          return;
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

      setPokemonIngestStatus(
        `Finished ${batch} batch(es), ~${totalRows} row upserts. The list updates automatically.`,
      );
      void loadSeries();
      void loadCardSetsForSeries(pokemonCardFiltersRef.current.series);
      void loadRarities();
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

  if (!url || !anon) {
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
              series, then per set in a series). After a fresh sign-in we start on that newest pair;
              you can re-select the top items in each dropdown to match.{" "}
            </>
          )}
          Choose another series, then set, to browse a different print run the same way. Use{" "}
          <strong>Clear filters</strong> to search the full catalog.
        </p>
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
                !pokemonCardFilters.series.trim() || cardSetOptionsLoading
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
          <div>
            <label>Rarity</label>
            <select
              value={pokemonCardFilters.rarity}
              onChange={(e) => updatePokemonCardFilter("rarity", e.target.value)}
            >
              <option value="">All rarities</option>
              {rarityOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Artist</label>
            <input
              value={pokemonCardFilters.artist}
              onChange={(e) => updatePokemonCardFilter("artist", e.target.value)}
              placeholder="Artist name"
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
        {(!pokemonFilterBootstrapped || pokemonCardsLoading) && (
          <p className="text-muted text-sm" style={{ marginBottom: "1rem" }}>
            {!pokemonFilterBootstrapped
              ? "Picking the newest series and set (by set release date)…"
              : "Loading catalog and sold comps…"}
          </p>
        )}
        {pokemonFilterBootstrapped && !pokemonCardsLoading && (
        <div className="pokemon-card-grid">
          {pokemonCards.map((c) => {
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
              <p className="pokemon-card-open-detail-hint text-muted text-sm">
                Open card for live Buy It Now on eBay
              </p>
              </Link>
              <div className="pokemon-card-comps-wrap">
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
                    {COMP_FINISH_ORDER.map((finish) => {
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
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          );
          })}
        </div>
        )}
        {pokemonFilterBootstrapped && pokemonCardsTotal > 0 && !pokemonCardsLoading && (
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
              disabled={pokemonCardsPageSafe <= 1 || pokemonCardsLoading}
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
                  disabled={pokemonCardsLoading}
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
                pokemonCardsPageSafe >= pokemonCardsTotalPages || pokemonCardsLoading
              }
              onClick={() =>
                setPokemonCardsPage((p) => Math.min(pokemonCardsTotalPages, p + 1))
              }
            >
              Next
            </button>
          </div>
        )}
        {pokemonFilterBootstrapped && pokemonCardsTotal === 0 && !pokemonCardsLoading && (
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
