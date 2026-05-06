-- Keyset-ordered batch for market-comps-ingest: coldest cards first (min max(market_rss_cards.updated_at), then id).
-- Never-refreshed cards use sort_ts = epoch so they sort before recently updated rows.

create index if not exists idx_market_rss_cards_pokemon_updated
  on public.market_rss_cards (pokemon_card_image_id, updated_at desc);

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

comment on function public.market_comps_next_cards(timestamptz, uuid, int) is
  'Next page of Pokémon cards for eBay comps: stalest first (keyset cursor = sort_ts + id).';

grant execute on function public.market_comps_next_cards(timestamptz, uuid, int) to service_role;
