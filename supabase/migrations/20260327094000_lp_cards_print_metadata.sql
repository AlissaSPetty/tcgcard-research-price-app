alter table public.lp_cards
  add column if not exists card_number text,
  add column if not exists card_set text,
  add column if not exists card_year int;

