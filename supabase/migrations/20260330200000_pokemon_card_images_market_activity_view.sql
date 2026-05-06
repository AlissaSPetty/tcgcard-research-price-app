-- Catalog list ordered by latest market comp activity (max updated_at across finishes).

drop view if exists public.pokemon_card_images_with_market_activity;

create view public.pokemon_card_images_with_market_activity
with (security_invoker = true) as
select
  p.id,
  p.external_id,
  p.name,
  p.image_url,
  p.holo_image_url,
  p.reverse_holo_image_url,
  p.card_set,
  p.details,
  p.rarity,
  p.evolves_from,
  p.artist,
  p.card_number,
  p.created_at,
  p.updated_at,
  (
    select max(m.updated_at)
    from public.market_rss_cards m
    where m.pokemon_card_image_id = p.id
  ) as last_market_comp_at
from public.pokemon_card_images p;

comment on view public.pokemon_card_images_with_market_activity is
  'Same rows as pokemon_card_images with last_market_comp_at = max(market_rss_cards.updated_at) per card.';

grant select on public.pokemon_card_images_with_market_activity to authenticated;
