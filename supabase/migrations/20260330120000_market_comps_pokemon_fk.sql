-- Market comps keyed by catalog card + finish (Pokémon TCG images), not RSS listing titles.

truncate table public.market_rss_cards;

drop index if exists public.market_rss_cards_dedupe_idx;

alter table public.market_rss_cards
  add column if not exists pokemon_card_image_id uuid references public.pokemon_card_images (id) on delete cascade,
  add column if not exists card_set text;

create unique index market_rss_cards_pokemon_finish_uidx
  on public.market_rss_cards (pokemon_card_image_id, card_type)
  where pokemon_card_image_id is not null;

create index idx_market_rss_cards_pokemon_image
  on public.market_rss_cards (pokemon_card_image_id)
  where pokemon_card_image_id is not null;

comment on table public.market_rss_cards is 'eBay active BIN comps per Pokémon catalog card + finish; populated from Browse API via market-comps-ingest.';
comment on column public.market_rss_cards.pokemon_card_image_id is 'Source row in pokemon_card_images; one market row per (id, card_type) for Normal/Holo/Reverse Holo.';
comment on column public.market_rss_cards.card_set is 'Denormalized set name from pokemon_card_images for display/debug.';
comment on column public.market_rss_cards.rss_title is 'Canonical comp label (not RSS); title_norm used for display only.';
