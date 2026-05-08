begin;

create table if not exists public.listing_catalog_meta (
  id boolean primary key default true check (id),
  tcgcsv_catalog_generation bigint not null default 1,
  tcgcsv_ingest_running boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.listing_catalog_meta (id, tcgcsv_catalog_generation, tcgcsv_ingest_running)
values (true, 1, false)
on conflict (id) do nothing;

create table if not exists public.dashboard_hot_movers (
  pokemon_card_image_id uuid primary key references public.pokemon_card_images (id) on delete cascade,
  rank int not null check (rank >= 1 and rank <= 24),
  tcgplayer_card_max_abs_price_delta_cents int not null,
  tcgplayer_card_price_delta_sign int not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists dashboard_hot_movers_rank_uidx
  on public.dashboard_hot_movers (rank);

create or replace function public.listing_catalog_status()
returns table (generation bigint, ingest_running boolean)
language sql
security invoker
stable
as $$
  select m.tcgcsv_catalog_generation, m.tcgcsv_ingest_running
  from public.listing_catalog_meta m
  where m.id = true
$$;

create or replace function public.set_listing_catalog_ingest_running(p_running boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.listing_catalog_meta
  set
    tcgcsv_ingest_running = p_running,
    updated_at = now()
  where id = true;
end;
$$;

create or replace function public.finalize_listing_catalog_generation_bump()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_generation bigint;
begin
  lock table public.listing_catalog_meta in row exclusive mode;
  lock table public.dashboard_hot_movers in row exclusive mode;

  delete from public.dashboard_hot_movers;
  insert into public.dashboard_hot_movers (
    pokemon_card_image_id,
    rank,
    tcgplayer_card_max_abs_price_delta_cents,
    tcgplayer_card_price_delta_sign,
    updated_at
  )
  select
    v.id,
    row_number() over (
      order by
        v.tcgplayer_card_max_abs_price_delta_cents desc nulls last,
        v.name asc,
        v.id asc
    ) as rank,
    v.tcgplayer_card_max_abs_price_delta_cents,
    coalesce(v.tcgplayer_card_price_delta_sign, 0),
    now()
  from public.pokemon_card_images_with_market_activity v
  where v.tcgplayer_card_max_abs_price_delta_cents is not null
  limit 24;

  update public.listing_catalog_meta
  set
    tcgcsv_catalog_generation = tcgcsv_catalog_generation + 1,
    tcgcsv_ingest_running = false,
    updated_at = now()
  where id = true
  returning tcgcsv_catalog_generation into v_new_generation;

  return v_new_generation;
end;
$$;

grant execute on function public.listing_catalog_status() to authenticated;
grant execute on function public.listing_catalog_status() to anon;

alter publication supabase_realtime drop table if exists public.pokemon_card_images;
alter publication supabase_realtime add table public.listing_catalog_meta;

commit;
