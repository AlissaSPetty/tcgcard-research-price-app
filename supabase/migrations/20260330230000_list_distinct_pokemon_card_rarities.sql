-- Distinct rarity strings for listing-admin Rarity filter dropdown.

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
  order by rarity;
$$;

comment on function public.list_distinct_pokemon_card_rarities() is
  'Distinct non-empty rarity values from pokemon_card_images; used by listing admin UI.';

grant execute on function public.list_distinct_pokemon_card_rarities() to authenticated;
