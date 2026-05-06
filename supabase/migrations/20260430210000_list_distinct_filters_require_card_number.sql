-- Series/set/rarity dropdowns: only rows with a TCGPlayer collector number (single cards).
-- Sealed products from tcgcsv lack "Number" in extendedData; we exclude those from DISTINCT lists so
-- they match pokemon_card_images_with_market_activity + listing-admin card grid filters.

drop function if exists public.list_distinct_pokemon_series();
drop function if exists public.list_distinct_pokemon_card_sets_for_series(text);
drop function if exists public.list_distinct_pokemon_card_sets();

create function public.list_distinct_pokemon_series()
returns table (series text, sort_newest date)
language sql
stable
security invoker
set search_path = public
as $$
  select s.series, s.newest
  from (
    select
      p.series,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where p.series is not null and btrim(p.series) <> ''
      and p.card_number is not null and btrim(p.card_number) <> ''
    group by p.series
  ) s
  order by s.newest desc nulls last, s.series;
$$;

comment on function public.list_distinct_pokemon_series() is
  'Distinct series that have at least one single-card row (non-empty tcgcsv Number); plus max set release date.';

grant execute on function public.list_distinct_pokemon_series() to authenticated;

create function public.list_distinct_pokemon_card_sets_for_series(p_series text)
returns table (card_set text, sort_newest date)
language sql
stable
security invoker
set search_path = public
as $$
  select t.card_set, t.newest
  from (
    select
      p.card_set,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where btrim(coalesce(p_series, '')) <> ''
      and p.series = btrim(p_series)
      and p.card_set is not null
      and btrim(p.card_set) <> ''
      and p.card_number is not null and btrim(p.card_number) <> ''
    group by p.card_set
  ) t
  order by t.newest desc nulls last, t.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets_for_series(text) is
  'Distinct card_set in a series that have at least one single-card row; max release date; newest first.';

grant execute on function public.list_distinct_pokemon_card_sets_for_series(text) to authenticated;

create function public.list_distinct_pokemon_card_sets()
returns table (card_set text, sort_newest date)
language sql
stable
security invoker
set search_path = public
as $$
  select t.card_set, t.newest
  from (
    select
      p.card_set,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where p.card_set is not null and btrim(p.card_set) <> ''
      and p.card_number is not null and btrim(p.card_number) <> ''
    group by p.card_set
  ) t
  order by t.newest desc nulls last, t.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets() is
  'Distinct card_set with at least one single-card row; max release date; newest first.';

grant execute on function public.list_distinct_pokemon_card_sets() to authenticated;

create or replace function public.list_distinct_pokemon_card_rarities()
returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select distinct rarity
  from public.pokemon_card_images
  where rarity is not null and btrim(rarity) <> ''
    and card_number is not null and btrim(card_number) <> ''
  order by rarity;
$$;

comment on function public.list_distinct_pokemon_card_rarities() is
  'Distinct non-empty rarities from single-card rows only (non-empty collector number).';
