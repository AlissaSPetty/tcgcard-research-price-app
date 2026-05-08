-- TCGPlayer price change since previous catalog ingest (tcgplayer_price_snapshots),
-- for default catalog sort and dashboard indicators. eBay BIN deltas stay on
-- card_max_abs_price_delta_cents / card_price_delta_sign.

begin;

drop view if exists public.pokemon_card_images_with_market_activity;

create view public.pokemon_card_images_with_market_activity
with (security_invoker = true) as
select
  p.id,
  p.tcgplayer_product_id,
  p.tcgplayer_price_cents,
  p.tcgplayer_prices_by_finish,
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
  tcg.tcgplayer_card_max_abs_price_delta_cents,
  tcg.tcgplayer_card_price_delta_sign,
  tcg.tcgplayer_delta_normal_cents,
  tcg.tcgplayer_delta_holo_cents,
  tcg.tcgplayer_delta_reverse_holo_cents,
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
) d on true
left join lateral (
  with
  latest_t as (
    select max(s.ingested_at) as t
    from public.tcgplayer_price_snapshots s
    where s.pokemon_card_image_id = p.id
  ),
  prev_t as (
    select max(s.ingested_at) as t
    from public.tcgplayer_price_snapshots s
    cross join latest_t lt
    where s.pokemon_card_image_id = p.id
      and lt.t is not null
      and s.ingested_at < lt.t
  ),
  curr_n as (
    select s.market_price_cents as cents
    from public.tcgplayer_price_snapshots s
    cross join latest_t lt
    where s.pokemon_card_image_id = p.id
      and lt.t is not null
      and s.ingested_at = lt.t
      and s.sub_type_name in ('Normal', 'normal')
    order by s.sub_type_name
    limit 1
  ),
  prev_n as (
    select s.market_price_cents as cents
    from public.tcgplayer_price_snapshots s
    cross join prev_t pt
    where s.pokemon_card_image_id = p.id
      and pt.t is not null
      and s.ingested_at = pt.t
      and s.sub_type_name in ('Normal', 'normal')
    order by s.sub_type_name
    limit 1
  ),
  curr_h as (
    select s.market_price_cents as cents
    from public.tcgplayer_price_snapshots s
    cross join latest_t lt
    where s.pokemon_card_image_id = p.id
      and lt.t is not null
      and s.ingested_at = lt.t
      and s.sub_type_name in ('Holofoil', 'Holo', 'holofoil')
    order by s.sub_type_name
    limit 1
  ),
  prev_h as (
    select s.market_price_cents as cents
    from public.tcgplayer_price_snapshots s
    cross join prev_t pt
    where s.pokemon_card_image_id = p.id
      and pt.t is not null
      and s.ingested_at = pt.t
      and s.sub_type_name in ('Holofoil', 'Holo', 'holofoil')
    order by s.sub_type_name
    limit 1
  ),
  curr_r as (
    select s.market_price_cents as cents
    from public.tcgplayer_price_snapshots s
    cross join latest_t lt
    where s.pokemon_card_image_id = p.id
      and lt.t is not null
      and s.ingested_at = lt.t
      and s.sub_type_name in (
        'Reverse Holofoil',
        'Reverse Holo',
        'reverse holofoil'
      )
    order by s.sub_type_name
    limit 1
  ),
  prev_r as (
    select s.market_price_cents as cents
    from public.tcgplayer_price_snapshots s
    cross join prev_t pt
    where s.pokemon_card_image_id = p.id
      and pt.t is not null
      and s.ingested_at = pt.t
      and s.sub_type_name in (
        'Reverse Holofoil',
        'Reverse Holo',
        'reverse holofoil'
      )
    order by s.sub_type_name
    limit 1
  ),
  dnorm as (
    select
      case
        when (select cents from curr_n) is not null
          and (select cents from prev_n) is not null
        then (select cents from curr_n) - (select cents from prev_n)
      end as v
  ),
  dholo as (
    select
      case
        when (select cents from curr_h) is not null
          and (select cents from prev_h) is not null
        then (select cents from curr_h) - (select cents from prev_h)
      end as v
  ),
  drev as (
    select
      case
        when (select cents from curr_r) is not null
          and (select cents from prev_r) is not null
        then (select cents from curr_r) - (select cents from prev_r)
      end as v
  ),
  agg as (
    select
      (select v from dnorm) as tcgplayer_delta_normal_cents,
      (select v from dholo) as tcgplayer_delta_holo_cents,
      (select v from drev) as tcgplayer_delta_reverse_holo_cents
  )
  select
    a.tcgplayer_delta_normal_cents,
    a.tcgplayer_delta_holo_cents,
    a.tcgplayer_delta_reverse_holo_cents,
    (
      select max(abs(x))
      from (
        values
          (a.tcgplayer_delta_normal_cents),
          (a.tcgplayer_delta_holo_cents),
          (a.tcgplayer_delta_reverse_holo_cents)
      ) as t(x)
      where x is not null
    ) as tcgplayer_card_max_abs_price_delta_cents,
    (
      select
        case
          when v > 0 then 1
          when v < 0 then -1
          else 0
        end
      from (
        values
          (a.tcgplayer_delta_normal_cents),
          (a.tcgplayer_delta_holo_cents),
          (a.tcgplayer_delta_reverse_holo_cents)
      ) as u(v)
      where v is not null
      order by abs(v) desc
      limit 1
    ) as tcgplayer_card_price_delta_sign
  from agg a
) tcg on true;

comment on view public.pokemon_card_images_with_market_activity is
  'pokemon_card_images + market + tcgplayer columns; eBay delta (card_max_*), TCG snapshot delta (tcgplayer_*), card_number_sort_*, last_sold_comp_at.';

grant select on public.pokemon_card_images_with_market_activity to authenticated;

commit;
