-- Remove set-name registry and per-card language (no longer used for search / ingest).

drop index if exists public.idx_market_rss_cards_set;

alter table public.market_rss_cards drop column if exists set_name_id;
alter table public.market_rss_cards drop column if exists language;

drop table if exists public.market_set_names;
