-- Distinct print set names for listing-admin Set filter dropdown.

create or replace function public.list_distinct_pokemon_card_sets()
returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select distinct card_set
  from public.pokemon_card_images
  where card_set is not null and btrim(card_set) <> ''
  order by card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets() is
  'Distinct non-empty card_set values from pokemon_card_images; used by listing admin UI.';

grant execute on function public.list_distinct_pokemon_card_sets() to authenticated;
