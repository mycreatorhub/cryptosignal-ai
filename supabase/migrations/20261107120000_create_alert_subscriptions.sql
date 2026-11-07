create table if not exists public.alert_subscriptions (
  telegram_user_id bigint primary key check (telegram_user_id > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.alert_subscriptions enable row level security;

revoke all on table public.alert_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on table public.alert_subscriptions to service_role;
