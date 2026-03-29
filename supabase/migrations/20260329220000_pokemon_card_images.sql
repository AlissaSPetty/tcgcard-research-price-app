-- Pokémon card image catalog (synced from external API, e.g. Pokémon TCG API v2).

create table public.pokemon_card_images (
  id uuid primary key default gen_random_uuid(),
  external_id text not null,
  name text not null,
  image_url text,
  holo_image_url text,
  reverse_holo_image_url text,
  card_set text,
  details text,
  rarity text,
  evolves_from text,
  artist text,
  card_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (external_id)
);

create index idx_pokemon_card_images_name_lower on public.pokemon_card_images (lower(name));
create index idx_pokemon_card_images_card_set on public.pokemon_card_images (card_set);
create index idx_pokemon_card_images_updated on public.pokemon_card_images (updated_at desc);

alter table public.pokemon_card_images enable row level security;

create policy pokemon_card_images_select on public.pokemon_card_images
  for select to authenticated using (true);

create policy pokemon_card_images_write_authenticated on public.pokemon_card_images
  for all to authenticated using (true) with check (true);

alter publication supabase_realtime add table public.pokemon_card_images;

comment on table public.pokemon_card_images is 'Pokémon card metadata and image URLs; populated by pokemon-card-images-ingest Edge Function.';
comment on column public.pokemon_card_images.external_id is 'Stable id from upstream API (e.g. Pokémon TCG API card id).';
comment on column public.pokemon_card_images.card_set is 'Print set name (column named card_set because set is reserved in SQL).';
