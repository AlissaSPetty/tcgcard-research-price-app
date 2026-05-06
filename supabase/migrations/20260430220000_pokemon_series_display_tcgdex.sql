-- Normalized tcgcsv/TCGPlayer series prefix (e.g. ME, SWSH) + optional display name from TCGdex
-- @see https://tcgdex.dev/ JSON API

create table if not exists public.pokemon_series_display (
  series_prefix text primary key,
  display_name text,
  tcgdex_series_id text,
  enriched_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.pokemon_series_display is
  'Maps tcgcsv group code prefix (letters before trailing digits, uppercased) to display series names from TCGdex API.';

comment on column public.pokemon_series_display.series_prefix is
  'Normalized prefix from tcgcsv group name, e.g. ME from ME03: Perfect Order.';

comment on column public.pokemon_series_display.display_name is
  'Human-readable series name from TCGdex (e.g. Mega Evolution); null if TCGdex has no matching series id.';

alter table public.pokemon_series_display enable row level security;

create policy "pokemon_series_display_select_authenticated"
  on public.pokemon_series_display
  for select
  to authenticated
  using (true);

grant select on public.pokemon_series_display to authenticated;
grant select, insert, update, delete on public.pokemon_series_display to service_role;

-- Catalog `series`: tcgcsv code before ":" with trailing digits stripped (ME03 -> ME).
update public.pokemon_card_images p
set series = upper(regexp_replace(trim(p.series), '\d+$', ''))
where p.series is not null and trim(p.series) <> '';

comment on column public.pokemon_card_images.series is
  'Print-era prefix from tcgcsv group name: segment before ":", trailing digits stripped, uppercased (e.g. ME). Join pokemon_series_display for TCGdex label.';

insert into public.pokemon_series_display (series_prefix)
select distinct p.series
from public.pokemon_card_images p
where p.series is not null and btrim(p.series) <> ''
on conflict (series_prefix) do nothing;

drop function if exists public.list_distinct_pokemon_series();

create function public.list_distinct_pokemon_series()
returns table (series text, display_name text, sort_newest date)
language sql
stable
security invoker
set search_path = public
as $$
  select s.series, d.display_name, s.newest
  from (
    select
      p.series,
      max(p.set_release_date) as newest
    from public.pokemon_card_images p
    where p.series is not null and btrim(p.series) <> ''
      and p.card_number is not null and btrim(p.card_number) <> ''
    group by p.series
  ) s
  left join public.pokemon_series_display d on d.series_prefix = s.series
  order by s.newest desc nulls last, s.series;
$$;

comment on function public.list_distinct_pokemon_series() is
  'Distinct series prefixes (single-card rows); optional display_name from pokemon_series_display / TCGdex; sort by newest set release.';

grant execute on function public.list_distinct_pokemon_series() to authenticated;
