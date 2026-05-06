-- Series (Pokémon TCG API set.series) for series → set filtering in listing-admin.

alter table public.pokemon_card_images
  add column if not exists series text;

comment on column public.pokemon_card_images.series is
  'Print series from API card.set.series (e.g. Sword & Shield); pairs with card_set.';

create index if not exists idx_pokemon_card_images_series
  on public.pokemon_card_images (series);

create index if not exists idx_pokemon_card_images_series_card_set
  on public.pokemon_card_images (series, card_set);

-- View: include series for filters and select.
-- DROP + CREATE (not OR REPLACE): inserting a column before card_set would otherwise error
-- with "cannot change name of view column card_set to series" (42P16).

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
  p.series,
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
  'pokemon_card_images + market activity, price delta, card_number_sort_*, includes series for filters.';

grant select on public.pokemon_card_images_with_market_activity to authenticated;

-- Dropdowns for listing-admin.

create or replace function public.list_distinct_pokemon_series()
returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select distinct series
  from public.pokemon_card_images
  where series is not null and btrim(series) <> ''
  order by series;
$$;

comment on function public.list_distinct_pokemon_series() is
  'Distinct non-empty series values for listing-admin series filter.';

grant execute on function public.list_distinct_pokemon_series() to authenticated;

create or replace function public.list_distinct_pokemon_card_sets_for_series(p_series text)
returns setof text
language sql
stable
security invoker
set search_path = public
as $$
  select distinct card_set
  from public.pokemon_card_images
  where btrim(coalesce(p_series, '')) <> ''
    and series = btrim(p_series)
    and card_set is not null
    and btrim(card_set) <> ''
  order by card_set;
$$;

comment on function public.list_distinct_pokemon_card_sets_for_series(text) is
  'Distinct card_set names within a series for listing-admin set dropdown.';

grant execute on function public.list_distinct_pokemon_card_sets_for_series(text) to authenticated;
