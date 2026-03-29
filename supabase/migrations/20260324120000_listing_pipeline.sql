-- Listing pipeline: eBay drafts, pricing snapshots, audit (RLS per user)

create type public.lp_card_status as enum (
  'pending_pricing',
  'pending_bundle',
  'ready_draft',
  'draft_created',
  'live',
  'ended',
  'error'
);

create type public.lp_price_source as enum ('ebay', 'tcg', 'blended');

create type public.lp_audit_action as enum (
  'draft_created',
  'published',
  'relisted',
  'ended',
  'refresh_30d',
  'price_check_skip',
  'error'
);

-- eBay OAuth + policy IDs (read/write via Edge Functions with service role; users see own row metadata)
create table public.lp_ebay_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  ebay_user_id text,
  refresh_token_encrypted text,
  access_token_cached text,
  access_token_expires_at timestamptz,
  scopes text,
  fulfillment_policy_id text,
  payment_policy_id text,
  return_policy_id text,
  merchant_location_key text,
  marketplace_id text not null default 'EBAY_US',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table public.lp_listing_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text,
  created_at timestamptz not null default now()
);

create table public.lp_bundles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  batch_id uuid references public.lp_listing_batches (id) on delete set null,
  title_hint text,
  draft_price_cents int not null default 400 check (draft_price_cents >= 400),
  status public.lp_card_status not null default 'pending_pricing',
  sku text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lp_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  batch_id uuid references public.lp_listing_batches (id) on delete cascade,
  bundle_id uuid references public.lp_bundles (id) on delete set null,
  front_image_path text not null,
  back_image_path text not null,
  content_hash text,
  title_hint text,
  unit_price_cents int,
  price_source public.lp_price_source,
  pricing_confidence numeric,
  status public.lp_card_status not null default 'pending_pricing',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

create table public.lp_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bundle_id uuid references public.lp_bundles (id) on delete set null,
  card_id uuid references public.lp_cards (id) on delete set null,
  sku text not null,
  inventory_item_key text,
  offer_id text,
  listing_id text,
  current_price_cents int not null check (current_price_cents >= 400),
  floor_cents int not null default 400 check (floor_cents >= 400),
  listed_at timestamptz,
  last_relisted_at timestamptz,
  last_comp_check_at timestamptz,
  is_live boolean not null default false,
  automation_enabled boolean not null default true,
  title text,
  description text,
  category_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lp_listings_one_target check (
    (bundle_id is not null and card_id is null)
    or (bundle_id is null and card_id is not null)
  ),
  unique (user_id, sku)
);

create index idx_lp_cards_user_status on public.lp_cards (user_id, status);
create index idx_lp_listings_user_live on public.lp_listings (user_id, is_live);
create index idx_lp_listings_last_relisted on public.lp_listings (user_id, last_relisted_at);

create table public.lp_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.lp_listings (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  snapshot_at timestamptz not null default now(),
  daily_median_cents int,
  weekly_median_cents int,
  comp_sample_size int,
  raw jsonb not null default '{}'::jsonb
);

create index idx_lp_price_snapshots_listing on public.lp_price_snapshots (listing_id, snapshot_at desc);

create table public.lp_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  listing_id uuid references public.lp_listings (id) on delete set null,
  action public.lp_audit_action not null,
  message text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- RLS
alter table public.lp_ebay_accounts enable row level security;
alter table public.lp_listing_batches enable row level security;
alter table public.lp_bundles enable row level security;
alter table public.lp_cards enable row level security;
alter table public.lp_listings enable row level security;
alter table public.lp_price_snapshots enable row level security;
alter table public.lp_audit_log enable row level security;

-- Users: full CRUD on own listing data; tokens only visible to owner for metadata (not exposing refresh token in select is done by view or omitting column from client - we allow select but client should not display secrets; service role bypasses RLS)
create policy lp_ebay_accounts_own on public.lp_ebay_accounts
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy lp_batches_own on public.lp_listing_batches
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy lp_bundles_own on public.lp_bundles
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy lp_cards_own on public.lp_cards
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy lp_listings_own on public.lp_listings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy lp_price_snapshots_own on public.lp_price_snapshots
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy lp_audit_own on public.lp_audit_log
  for select to authenticated using (auth.uid() = user_id);

-- Storage bucket for card images
insert into storage.buckets (id, name, public)
values ('listing-card-images', 'listing-card-images', false)
on conflict (id) do nothing;

create policy listing_images_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'listing-card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy listing_images_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'listing-card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy listing_images_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'listing-card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'listing-card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy listing_images_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'listing-card-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Secure view: hide refresh token from PostgREST for anon/authenticated
create or replace view public.lp_ebay_accounts_safe
with (security_invoker = true) as
select
  id,
  user_id,
  ebay_user_id,
  access_token_expires_at,
  scopes,
  fulfillment_policy_id,
  payment_policy_id,
  return_policy_id,
  merchant_location_key,
  marketplace_id,
  created_at,
  updated_at,
  (refresh_token_encrypted is not null) as has_refresh_token
from public.lp_ebay_accounts;

grant select on public.lp_ebay_accounts_safe to authenticated;
