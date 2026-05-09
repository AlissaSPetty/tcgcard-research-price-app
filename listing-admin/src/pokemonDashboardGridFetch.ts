import { supabase } from "./supabaseClient";

export const POKEMON_CARDS_PAGE_SIZE = 30;

export type PokemonCardFilters = {
  name: string;
  series: string;
  card_set: string;
  card_number: string;
};

export const EMPTY_POKEMON_CARD_FILTERS: PokemonCardFilters = {
  name: "",
  series: "",
  card_set: "",
  card_number: "",
};

export type PokemonCardImageRow = {
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
  last_market_comp_at: string | null;
  last_sold_comp_at: string | null;
  tcgplayer_card_max_abs_price_delta_cents: number | null;
  tcgplayer_card_price_delta_sign: number | null;
  tcgplayer_delta_normal_cents: number | null;
  tcgplayer_delta_holo_cents: number | null;
  tcgplayer_delta_reverse_holo_cents: number | null;
  card_number_sort_primary: number | null;
  card_number_sort_secondary: number | null;
};

export type DashboardGridQueryResult = {
  rows: PokemonCardImageRow[];
  total: number;
};

function ilikeContainsPattern(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const safe = t.replace(/[%_\\]/g, "");
  if (!safe) return null;
  return `%${safe}%`;
}

export function fetchPokemonDashboardGrid(args: {
  page: number;
  filters: PokemonCardFilters;
  hotIds: string[];
}): Promise<DashboardGridQueryResult> {
  const { page, filters, hotIds } = args;
  const from = (page - 1) * POKEMON_CARDS_PAGE_SIZE;
  const to = from + POKEMON_CARDS_PAGE_SIZE - 1;
  let q = supabase
    .from("pokemon_card_images_with_market_activity")
    .select(
      "id, tcgplayer_product_id, tcgplayer_price_cents, tcgplayer_prices_by_finish, name, image_url, holo_image_url, reverse_holo_image_url, series, card_set, details, rarity, artist, card_number, created_at, updated_at, last_market_comp_at, last_sold_comp_at, tcgplayer_card_max_abs_price_delta_cents, tcgplayer_card_price_delta_sign, tcgplayer_delta_normal_cents, tcgplayer_delta_holo_cents, tcgplayer_delta_reverse_holo_cents, card_number_sort_primary, card_number_sort_secondary",
      { count: "exact" },
    );
  q = q.not("card_number", "is", null).neq("card_number", "");
  const addIlike = (
    column: keyof Pick<PokemonCardImageRow, "name" | "card_number">,
    value: string,
  ) => {
    const pat = ilikeContainsPattern(value);
    if (pat) q = q.ilike(column, pat);
  };
  addIlike("name", filters.name);
  const seriesPick = filters.series.trim();
  const setPick = filters.card_set.trim();
  const nameSearchSpansCatalog = ilikeContainsPattern(filters.name) != null;
  const effectiveSeries = nameSearchSpansCatalog ? "" : seriesPick;
  const effectiveSet = nameSearchSpansCatalog ? "" : setPick;
  if (effectiveSeries) q = q.eq("series", effectiveSeries);
  if (effectiveSet) q = q.eq("card_set", effectiveSet);
  addIlike("card_number", filters.card_number);
  const unfiltered =
    !filters.name.trim() &&
    !filters.series.trim() &&
    !filters.card_set.trim() &&
    !filters.card_number.trim();
  if (unfiltered && hotIds.length > 0) {
    const list = hotIds.map((id) => `'${id}'`).join(",");
    q = q.not("id", "in", `(${list})`);
  }
  const seriesAndSet = Boolean(effectiveSeries && effectiveSet);
  let ordered = q;
  if (seriesAndSet) {
    ordered = q
      .order("card_number_sort_primary", { ascending: true, nullsFirst: false })
      .order("card_number_sort_secondary", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true });
  } else {
    ordered = q.order("tcgplayer_card_max_abs_price_delta_cents", {
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
  return ordered.range(from, to).then(({ data, error: e, count }) => {
    if (e) throw e;
    return { rows: (data ?? []) as PokemonCardImageRow[], total: count ?? 0 };
  });
}
