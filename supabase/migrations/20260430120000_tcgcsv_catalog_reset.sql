-- Clean reset: wipe catalog, market, and listing-pipeline data; key pokemon_card_images on TCGPlayer productId (tcgcsv).

begin;

-- View depends on external_id; drop before ALTER.
drop view if exists public.pokemon_card_images_with_market_activity;

-- Single multitable TRUNCATE so PostgreSQL orders by FKs (e.g. market_sold_comp_snapshots → market_sold_comps).
-- Omit lp_price_snapshots / lp_listings — removed in 20260329200000_drop_lp_listings_and_snapshots.sql
truncate table
  public.market_rss_active_observations,
  public.market_sold_comp_snapshots,
  public.pokemon_card_market_refresh,
  public.market_sold_comps,
  public.market_rss_cards,
  public.lp_audit_log,
  public.lp_cards,
  public.lp_bundles,
  public.lp_listing_batches,
  public.lp_ebay_accounts,
  public.lp_oauth_states,
  public.pokemon_card_images
restart identity cascade;

alter table public.pokemon_card_images
  drop column if exists external_id;

alter table public.pokemon_card_images
  add column tcgplayer_product_id bigint not null;

create unique index pokemon_card_images_tcgplayer_product_id_uidx
  on public.pokemon_card_images (tcgplayer_product_id);

comment on table public.pokemon_card_images is
  'Pokémon card metadata and image URLs; populated from tcgcsv.com (TCGPlayer product catalog).';

comment on column public.pokemon_card_images.tcgplayer_product_id is
  'TCGPlayer productId from tcgcsv; single source of truth for catalog identity.';

comment on column public.pokemon_card_images.set_release_date is
  'Print set or product release date; from tcgcsv group or product presale.';

comment on column public.pokemon_card_images.series is
  'Heuristic label from tcgcsv group name (e.g. prefix before ":"); used with card_set in filters.';

-- Same shape as 20260330280000, with tcgplayer id instead of external_id.
create view public.pokemon_card_images_with_market_activity
with (security_invoker = true) as
select
  p.id,
  p.tcgplayer_product_id,
  p.name,
  p.image_url,
  p.holo_image_url,
  p.reverse_holo_image_url,
  p.series,
  p.card_set,
  p.details,
  p.rarity,
  p.evolves_from,
  p.artist,
  p.card_number,
  p.set_release_date,
  p.created_at,
  p.updated_at,
  (
    select max(m.updated_at)
    from public.market_rss_cards m
    where m.pokemon_card_image_id = p.id
  ) as last_market_comp_at,
  (
    select max(s.updated_at)
    from public.market_sold_comps s
    where s.pokemon_card_image_id = p.id
  ) as last_sold_comp_at,
  d.card_max_abs_price_delta_cents,
  d.card_price_delta_sign,
  nullif(
    regexp_replace(
      split_part(btrim(coalesce(p.card_number, '')), '/', 1),
      '[^0-9]',
      '',
      'g'
    ),
    ''
  )::bigint as card_number_sort_primary,
  nullif(
    regexp_replace(
      split_part(btrim(coalesce(p.card_number, '')), '/', 2),
      '[^0-9]',
      '',
      'g'
    ),
    ''
  )::bigint as card_number_sort_secondary
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
  'pokemon_card_images + market activity, price delta, card_number_sort_*, last_sold_comp_at, series, set_release_date.';

grant select on public.pokemon_card_images_with_market_activity to authenticated;

commit;
