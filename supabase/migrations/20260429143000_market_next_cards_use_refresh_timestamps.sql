-- Speed up stale cursor RPCs by using refresh-table timestamps directly.
-- Avoids per-card correlated max(updated_at) scans on market tables.

begin;

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
      coalesce(r.last_active_ingest_at, 'epoch'::timestamptz) as sort_ts,
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
      coalesce(r.last_sold_ingest_at, 'epoch'::timestamptz) as sort_ts,
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
  'Next page for Browse comps: due next_active_refresh_at, then tier (hot first), then stalest by last_active_ingest_at.';

comment on function public.market_sold_comps_next_cards(timestamptz, uuid, int) is
  'Next page for sold comps: due next_sold_refresh_at, then tier, then stalest by last_sold_ingest_at.';

grant execute on function public.market_comps_next_cards(timestamptz, uuid, int) to service_role;
grant execute on function public.market_sold_comps_next_cards(timestamptz, uuid, int) to service_role;

commit;
