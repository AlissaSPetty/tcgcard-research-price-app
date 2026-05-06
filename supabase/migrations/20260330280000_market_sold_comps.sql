-- Sold comps (eBay Finding API) per catalog card + finish; separate from active BIN rows in market_rss_cards.

create table public.market_sold_comps (
  id uuid primary key default gen_random_uuid(),
  pokemon_card_image_id uuid not null references public.pokemon_card_images (id) on delete cascade,
  card_type public.market_rss_card_type not null,
  rss_title text not null,
  card_name text,
  card_set text,
  card_number text,
  average_price_cents int,
  sample_size int not null default 0 check (sample_size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index market_sold_comps_pokemon_finish_uidx
  on public.market_sold_comps (pokemon_card_image_id, card_type);

create index idx_market_sold_comps_pokemon_updated
  on public.market_sold_comps (pokemon_card_image_id, updated_at desc);

comment on table public.market_sold_comps is
  'eBay sold listing comps (Finding API) per Pokémon catalog card + finish; populated via market-sold-comps-ingest.';
comment on column public.market_sold_comps.sample_size is
  'Number of completed listings averaged for average_price_cents (Finding API page).';

alter table public.market_sold_comps enable row level security;

create policy market_sold_comps_select on public.market_sold_comps
  for select to authenticated using (true);

create policy market_sold_comps_write_authenticated on public.market_sold_comps
  for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.market_sold_comps;

-- Stale-first batch for market-sold-comps-ingest (min max(updated_at) per card).
create or replace function public.market_sold_comps_next_cards(
  p_cursor_last_at timestamptz,
  p_cursor_id uuid,
  p_limit int
)
returns table (
  id uuid,
  name text,
  card_set text,
  card_number text,
  sort_ts timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with ranked as (
    select
      p.id,
      p.name,
      p.card_set,
      p.card_number,
      coalesce(
        (
          select max(s.updated_at)
          from public.market_sold_comps s
          where s.pokemon_card_image_id = p.id
        ),
        'epoch'::timestamptz
      ) as sort_ts
    from public.pokemon_card_images p
  )
  select r.id, r.name, r.card_set, r.card_number, r.sort_ts
  from ranked r
  where
    (p_cursor_last_at is null and p_cursor_id is null)
    or ((r.sort_ts, r.id) > (p_cursor_last_at, p_cursor_id))
  order by r.sort_ts asc, r.id asc
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$$;

comment on function public.market_sold_comps_next_cards(timestamptz, uuid, int) is
  'Next page of Pokémon cards for sold comps: stalest first (keyset cursor = sort_ts + id).';

grant execute on function public.market_sold_comps_next_cards(timestamptz, uuid, int) to service_role;

-- View: last sold comp refresh time per card.
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
  'pokemon_card_images + market activity, price delta, card_number_sort_*, last_sold_comp_at, includes series for filters.';

grant select on public.pokemon_card_images_with_market_activity to authenticated;
