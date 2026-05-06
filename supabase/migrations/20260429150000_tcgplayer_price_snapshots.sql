-- Append-only tcgcsv/TCGPlayer price history for charting.

begin;

create table if not exists public.tcgplayer_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  pokemon_card_image_id uuid references public.pokemon_card_images (id) on delete set null,
  tcgplayer_product_id bigint not null,
  sub_type_name text not null,
  market_price_cents int,
  low_price_cents int,
  high_price_cents int,
  direct_low_price_cents int,
  ingested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_tcgplayer_price_snapshots_product_ingested
  on public.tcgplayer_price_snapshots (tcgplayer_product_id, sub_type_name, ingested_at desc);

create index if not exists idx_tcgplayer_price_snapshots_card_ingested
  on public.tcgplayer_price_snapshots (pokemon_card_image_id, sub_type_name, ingested_at desc)
  where pokemon_card_image_id is not null;

comment on table public.tcgplayer_price_snapshots is
  'Append-only TCGPlayer/tcgcsv price history by product + subtype for charting.';

comment on column public.tcgplayer_price_snapshots.sub_type_name is
  'tcgcsv subTypeName (e.g. Normal, Holofoil, Reverse Holofoil).';

alter table public.tcgplayer_price_snapshots enable row level security;

create policy tcgplayer_price_snapshots_select
  on public.tcgplayer_price_snapshots
  for select to authenticated
  using (true);

commit;
