-- Set release date from Pokémon TCG API `set.releaseDate` (per card row) for filter dropdown ordering.

alter table public.pokemon_card_images
  add column if not exists set_release_date date;

comment on column public.pokemon_card_images.set_release_date is
  'Print set release date from API card.set.releaseDate; used to sort series/set filters (newest first).';

-- Series: newest max release date in that series first, then name.
create or replace function public.list_distinct_pokemon_series()
returns table (series text)
language sql
stable
security invoker
set search_path = public
as $$
  select s.series
  from (
    select
      p.series,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where p.series is not null and btrim(p.series) <> ''
    group by p.series
  ) s
  order by s.newest desc nulls last, s.series;
$$;

comment on function public.list_distinct_pokemon_series() is
  'Distinct non-empty series for listing-admin; ordered by latest set release date (newest first).';

-- Sets within a series: newest set first, then name.
create or replace function public.list_distinct_pokemon_card_sets_for_series(p_series text)
returns table (card_set text)
language sql
stable
security invoker
set search_path = public
as $$
  select t.card_set
  from (
    select
      p.card_set,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where btrim(coalesce(p_series, '')) <> ''
      and p.series = btrim(p_series)
      and p.card_set is not null
      and btrim(p.card_set) <> ''
    group by p.card_set
  ) t
  order by t.newest desc nulls last, t.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets_for_series(text) is
  'Distinct card_set within a series; ordered by set release date (newest first).';

-- Global set list (if used elsewhere): same ordering.
create or replace function public.list_distinct_pokemon_card_sets()
returns table (card_set text)
language sql
stable
security invoker
set search_path = public
as $$
  select t.card_set
  from (
    select
      p.card_set,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where p.card_set is not null and btrim(p.card_set) <> ''
    group by p.card_set
  ) t
  order by t.newest desc nulls last, t.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets() is
  'Distinct non-empty card_set values; ordered by latest release date (newest first).';
