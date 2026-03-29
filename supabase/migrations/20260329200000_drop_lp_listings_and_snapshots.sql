-- eBay inventory listing rows (draft + live) and price snapshots; drafts UI / pipeline removed.

alter table public.lp_audit_log
  drop constraint if exists lp_audit_log_listing_id_fkey;

drop table if exists public.lp_price_snapshots;

drop table if exists public.lp_listings;
