create table public.lp_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.lp_oauth_states enable row level security;

-- No RLS policies: service_role bypasses RLS; authenticated users cannot access this table.
