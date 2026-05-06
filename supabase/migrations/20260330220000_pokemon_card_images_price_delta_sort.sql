-- Catalog sort by largest |avg − previous| per card; expose sign for UI tint.

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
  ) as last_market_comp_at,
  d.card_max_abs_price_delta_cents,
  d.card_price_delta_sign
from public.pokemon_card_images p
left join lateral (
  select
    t.abs_d as card_max_abs_price_delta_cents,
    case
      when t.signed_d > 0 then 1
      when t.signed_d < 0 then -1
      else 0
    end as card_price_delta_sign
  from (
    select
      abs(
        coalesce(m.average_price_cents, 0) - coalesce(m.previous_average_price_cents, 0)
      ) as abs_d,
      coalesce(m.average_price_cents, 0) - coalesce(m.previous_average_price_cents, 0)
        as signed_d
    from public.market_rss_cards m
    where m.pokemon_card_image_id = p.id
    order by abs_d desc nulls last
    limit 1
  ) t
) d on true;

comment on view public.pokemon_card_images_with_market_activity is
  'pokemon_card_images + last_market_comp_at, card_max_abs_price_delta_cents (largest finish-level |Δprice|), card_price_delta_sign (−1/0/1 for that finish).';

grant select on public.pokemon_card_images_with_market_activity to authenticated;
