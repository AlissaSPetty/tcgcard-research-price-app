-- Store finish-specific eBay comp averages per card search.
alter table public.lp_cards
  add column if not exists normal_avg_price_cents int,
  add column if not exists holo_avg_price_cents int,
  add column if not exists reverse_holo_avg_price_cents int;

