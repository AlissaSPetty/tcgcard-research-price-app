-- Market RSS tracking: official set names + ingested eBay BIN listings (US, category via feed URL)

create table public.market_set_names (
  id uuid primary key default gen_random_uuid(),
  official_name text not null,
  similar_names text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (official_name)
);

create index idx_market_set_names_official_lower on public.market_set_names (lower(official_name));

create type public.market_rss_card_type as enum (
  'Normal',
  'Holo',
  'Reverse Holo',
  'Full Art'
);

create table public.market_rss_cards (
  id uuid primary key default gen_random_uuid(),
  rss_title text not null,
  title_norm text generated always as (lower(trim(rss_title))) stored,
  card_name text,
  set_name_id uuid references public.market_set_names (id) on delete set null,
  card_number text,
  language text not null default 'EN',
  listed_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  price_cents_history jsonb not null default '[]'::jsonb,
  shipping_history jsonb not null default '[]'::jsonb,
  shipping_average_free boolean not null default true,
  shipping_average_cents int,
  average_price_cents int,
  previous_average_price_cents int,
  card_type public.market_rss_card_type not null default 'Normal',
  quantity int not null default 1 check (quantity >= 1),
  ebay_item_id text,
  listing_url text,
  last_ingest_at timestamptz
);

create unique index market_rss_cards_dedupe_idx on public.market_rss_cards (
  title_norm,
  coalesce(card_number, ''),
  card_type
);

create index idx_market_rss_cards_set on public.market_rss_cards (set_name_id);
create index idx_market_rss_cards_updated on public.market_rss_cards (updated_at desc);
create index idx_market_rss_cards_ebay_item on public.market_rss_cards (ebay_item_id);

alter table public.market_set_names enable row level security;
alter table public.market_rss_cards enable row level security;

create policy market_set_names_select on public.market_set_names
  for select to authenticated using (true);

create policy market_set_names_write on public.market_set_names
  for all to authenticated using (true) with check (true);

create policy market_rss_cards_select on public.market_rss_cards
  for select to authenticated using (true);

-- Authenticated users: read/write for admin UI; anon has no access. Edge Function uses service role (bypasses RLS).
create policy market_rss_cards_write_authenticated on public.market_rss_cards
  for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.market_rss_cards;

comment on table public.market_set_names is 'Official TCG set names plus optional aliases matched against RSS titles.';
comment on table public.market_rss_cards is 'eBay listings ingested from RSS (BIN/US); deduped by normalized title + card number + finish type.';
comment on column public.market_rss_cards.shipping_history is 'JSON array: null or "free" for free shipping, or integer cents for paid shipping; max 5 entries.';
comment on column public.market_rss_cards.price_cents_history is 'JSON array of last up to 5 observed BIN prices in US cents.';
