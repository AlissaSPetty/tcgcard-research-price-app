-- PostgREST returns SETOF scalar functions as JSON arrays; RETURNS TABLE gives stable
-- `{ "series": "..." }` / `{ "card_set": "..." }` rows for listing-admin parsing.

drop function if exists public.list_distinct_pokemon_series();

create function public.list_distinct_pokemon_series()
returns table (series text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct p.series as series
  from public.pokemon_card_images p
  where p.series is not null and btrim(p.series) <> ''
  order by p.series;
$$;

comment on function public.list_distinct_pokemon_series() is
  'Distinct non-empty series values for listing-admin series filter.';

grant execute on function public.list_distinct_pokemon_series() to authenticated;

drop function if exists public.list_distinct_pokemon_card_sets_for_series(text);

create function public.list_distinct_pokemon_card_sets_for_series(p_series text)
returns table (card_set text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct p.card_set as card_set
  from public.pokemon_card_images p
  where btrim(coalesce(p_series, '')) <> ''
    and p.series = btrim(p_series)
    and p.card_set is not null
    and btrim(p.card_set) <> ''
  order by p.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets_for_series(text) is
  'Distinct card_set names within a series for listing-admin set dropdown.';

grant execute on function public.list_distinct_pokemon_card_sets_for_series(text) to authenticated;
