-- Expose max(set_release_date) in RPCs so the admin UI can sort filters even if the client
-- were to reorder columns; and to make non-null sort keys visible in API responses.

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
    group by p.series
  ) s
  order by s.newest desc nulls last, s.series;
$$;

comment on function public.list_distinct_pokemon_series() is
  'Distinct non-empty series + max set release date; order is newest first (for listing-admin).';

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
    group by p.card_set
  ) t
  order by t.newest desc nulls last, t.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets_for_series(text) is
  'Distinct card_set in a series + max release date; newest set first.';

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
    group by p.card_set
  ) t
  order by t.newest desc nulls last, t.card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets() is
  'Distinct card_set + max release date; newest first.';

grant execute on function public.list_distinct_pokemon_card_sets() to authenticated;
