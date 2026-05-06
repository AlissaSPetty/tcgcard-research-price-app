-- Append-only eBay comp history + per-card refresh cadence (active vs sold).

-- ---------------------------------------------------------------------------
-- 1) Active listing observations (one row per price sample from Browse)
-- ---------------------------------------------------------------------------
create table public.market_rss_active_observations (
  id uuid primary key default gen_random_uuid(),
  pokemon_card_image_id uuid not null references public.pokemon_card_images (id) on delete cascade,
  market_rss_card_id uuid references public.market_rss_cards (id) on delete set null,
  card_type public.market_rss_card_type not null,
  ebay_item_id text,
  listing_url text,
  observed_at timestamptz not null default now(),
  price_cents int not null,
  /** Browse shipping: {"kind":"free"|"unknown"|"paid","cents":?} */
  shipping jsonb,
  source text not null default 'browse',
  created_at timestamptz not null default now()
);

create index idx_market_rss_active_obs_pokemon_observed
  on public.market_rss_active_observations (pokemon_card_image_id, observed_at desc);

create index idx_market_rss_active_obs_ebay_item
  on public.market_rss_active_observations (ebay_item_id, observed_at desc)
  where ebay_item_id is not null;

create index idx_market_rss_active_obs_market_rss
  on public.market_rss_active_observations (market_rss_card_id, observed_at desc)
  where market_rss_card_id is not null;

comment on table public.market_rss_active_observations is
  'Append-only time series of eBay active BIN comp samples (Browse), per card + finish.';

-- ---------------------------------------------------------------------------
-- 2) Sold comp snapshots (one row per successful ingest of Finding aggregates)
-- ---------------------------------------------------------------------------
create table public.market_sold_comp_snapshots (
  id uuid primary key default gen_random_uuid(),
  pokemon_card_image_id uuid not null references public.pokemon_card_images (id) on delete cascade,
  card_type public.market_rss_card_type not null,
  market_sold_comp_id uuid references public.market_sold_comps (id) on delete set null,
  search_query text,
  average_price_cents int,
  sample_size int not null default 0 check (sample_size >= 0),
  ingested_at timestamptz not null default now()
);

create index idx_market_sold_snap_pokemon_ingested
  on public.market_sold_comp_snapshots (pokemon_card_image_id, card_type, ingested_at desc);

comment on table public.market_sold_comp_snapshots is
  'Time series of sold-comp aggregates from Finding (per ingest), for trend lines vs. market_sold_comps “current” row.';

-- ---------------------------------------------------------------------------
-- 3) Refresh scheduling + tier (heavy movers get shorter next_* window)
-- ---------------------------------------------------------------------------
create type public.pokemon_market_refresh_tier as enum ('hot', 'normal', 'cold');

create table public.pokemon_card_market_refresh (
  pokemon_card_image_id uuid primary key references public.pokemon_card_images (id) on delete cascade,
  refresh_tier public.pokemon_market_refresh_tier not null default 'normal',
  next_active_refresh_at timestamptz not null default 'epoch'::timestamptz,
  next_sold_refresh_at timestamptz not null default 'epoch'::timestamptz,
  last_active_ingest_at timestamptz,
  last_sold_ingest_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_pokemon_card_market_refresh_next_active
  on public.pokemon_card_market_refresh (next_active_refresh_at, pokemon_card_image_id);

create index idx_pokemon_card_market_refresh_next_sold
  on public.pokemon_card_market_refresh (next_sold_refresh_at, pokemon_card_image_id);

comment on table public.pokemon_card_market_refresh is
  'Per-card cadence for eBay comp ingests. Tier affects spacing of next_active_refresh_at / next_sold_refresh_at.';

-- Backfill one row per catalog card.
insert into public.pokemon_card_market_refresh (pokemon_card_image_id)
select p.id
from public.pokemon_card_images p
on conflict (pokemon_card_image_id) do nothing;

-- New catalog cards: ensure a refresh row exists.
create or replace function public.pokemon_card_market_refresh_on_new_card()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.pokemon_card_market_refresh (pokemon_card_image_id)
  values (new.id)
  on conflict (pokemon_card_image_id) do nothing;
  return new;
end;
$$;

create trigger trg_pokemon_card_market_refresh_new
  after insert on public.pokemon_card_images
  for each row
  execute function public.pokemon_card_market_refresh_on_new_card();

-- RLS
alter table public.market_rss_active_observations enable row level security;
alter table public.market_sold_comp_snapshots enable row level security;
alter table public.pokemon_card_market_refresh enable row level security;

create policy market_rss_active_observations_select
  on public.market_rss_active_observations
  for select to authenticated
  using (true);

create policy market_sold_comp_snapshots_select
  on public.market_sold_comp_snapshots
  for select to authenticated
  using (true);

create policy pokemon_card_market_refresh_select
  on public.pokemon_card_market_refresh
  for select to authenticated
  using (true);

-- Refresh tier from recent price activity (view = active BIN delta vs previous).
-- Run nightly via cron or manually.
create or replace function public.recompute_pokemon_market_tiers(
  p_hot_min_abs_delta_cents int default 500,
  p_cold_max_abs_delta_cents int default 100
)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  n int;
begin
  update public.pokemon_card_market_refresh r
  set
    refresh_tier = v.next_tier,
    updated_at = now()
  from (
    select
      p.id as pid,
      case
        when d.abs_d is not null and d.abs_d >= p_hot_min_abs_delta_cents
          then 'hot'::public.pokemon_market_refresh_tier
        when d.abs_d is not null and d.abs_d <= p_cold_max_abs_delta_cents
          then 'cold'::public.pokemon_market_refresh_tier
        else 'normal'
      end as next_tier
    from public.pokemon_card_images p
    left join lateral (
      select
        max(
          abs(
            coalesce(m.average_price_cents, 0) - coalesce(m.previous_average_price_cents, 0)
          )
        ) as abs_d
      from public.market_rss_cards m
      where m.pokemon_card_image_id = p.id
    ) d on true
  ) v
  where r.pokemon_card_image_id = v.pid
    and (r.refresh_tier is distinct from v.next_tier);

  get diagnostics n = row_count;
  return coalesce(n, 0);
end;
$$;

comment on function public.recompute_pokemon_market_tiers(int, int) is
  'Sets hot/normal/cold from |avg−prev| on market_rss_cards: hot >= p_hot, cold when no/null delta or tiny delta, else normal.';

grant execute on function public.recompute_pokemon_market_tiers(int, int) to service_role;

-- Stale-first + tier priority + only when next_active_refresh_at is due
create or replace function public.market_comps_next_cards(
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
          select max(m.updated_at)
          from public.market_rss_cards m
          where m.pokemon_card_image_id = p.id
        ),
        'epoch'::timestamptz
      ) as sort_ts,
      r.refresh_tier,
      r.next_active_refresh_at
    from public.pokemon_card_images p
    inner join public.pokemon_card_market_refresh r
      on r.pokemon_card_image_id = p.id
  ),
  due as (
    select * from ranked
    where next_active_refresh_at <= now()
  )
  select d.id, d.name, d.card_set, d.card_number, d.sort_ts
  from due d
  where
    (p_cursor_last_at is null and p_cursor_id is null)
    or ((d.sort_ts, d.id) > (p_cursor_last_at, p_cursor_id))
  order by
    case d.refresh_tier
      when 'hot' then 0
      when 'normal' then 1
      when 'cold' then 2
    end,
    d.sort_ts asc,
    d.id asc
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$$;

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
      ) as sort_ts,
      r.refresh_tier,
      r.next_sold_refresh_at
    from public.pokemon_card_images p
    inner join public.pokemon_card_market_refresh r
      on r.pokemon_card_image_id = p.id
  ),
  due as (
    select * from ranked
    where next_sold_refresh_at <= now()
  )
  select d.id, d.name, d.card_set, d.card_number, d.sort_ts
  from due d
  where
    (p_cursor_last_at is null and p_cursor_id is null)
    or ((d.sort_ts, d.id) > (p_cursor_last_at, p_cursor_id))
  order by
    case d.refresh_tier
      when 'hot' then 0
      when 'normal' then 1
      when 'cold' then 2
    end,
    d.sort_ts asc,
    d.id asc
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$$;

comment on function public.market_comps_next_cards(timestamptz, uuid, int) is
  'Next page for Browse comps: due next_active_refresh_at, then tier (hot first), then stalest sort_ts.';

comment on function public.market_sold_comps_next_cards(timestamptz, uuid, int) is
  'Next page for sold comps: due next_sold_refresh_at, then tier, then stalest.';

grant execute on function public.market_comps_next_cards(timestamptz, uuid, int) to service_role;
grant execute on function public.market_sold_comps_next_cards(timestamptz, uuid, int) to service_role;
