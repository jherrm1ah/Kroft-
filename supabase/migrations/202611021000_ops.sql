-- Running KROFT day to day: alerts to the owner, a nightly backup copy of everyone's data, and
-- the columns the feedback and error-log endpoints use to cap how much one device can send.
--
-- Additive only: two new tables, one function, two new nullable columns. Nothing existing is
-- changed or removed.

-- 1. Alerts: what was sent to the owner and when (also how repeats are held back).
create table if not exists public.alert_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  key         text not null,     -- what it's about, e.g. 'ai-failing', 'feedback:12'
  title       text not null,
  body        text,
  delivered   integer not null default 0   -- phones/browsers it reached
);
create index if not exists alert_events_key_created_idx on public.alert_events (key, created_at desc);
alter table public.alert_events enable row level security;   -- service role only

-- 2. Nightly backup: one copy per day of every kv_store row except uploaded files and voice
-- memos (too large for the free plan's database), kept for 7 days. Taken by the daily cron
-- (api/cron/deliver-notifications.js). Restoring is done by hand, row by row.
create table if not exists public.kv_store_backups (
  day         date not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  key         text not null,
  value       jsonb not null,
  updated_at  timestamptz,
  primary key (day, user_id, key)
);
alter table public.kv_store_backups enable row level security;   -- service role only

create or replace function public.backup_kv_store()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare copied integer;
begin
  insert into public.kv_store_backups (day, user_id, key, value, updated_at)
  select current_date, user_id, key, value, updated_at
  from public.kv_store
  where key not in ('kroft:files', 'kroft:voicememos')
  on conflict (day, user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at;
  get diagnostics copied = row_count;
  delete from public.kv_store_backups where day < current_date - 7;
  return copied;
end;
$$;
-- Only the server may run it.
revoke all on function public.backup_kv_store() from public, anon, authenticated;
grant execute on function public.backup_kv_store() to service_role;

-- 3. Spam limits: a one-way hash of the sender's network address (never the address itself),
-- so the endpoints can count how much one device sent in the last hour.
alter table public.user_feedback add column if not exists ip_hash text;
alter table public.client_error_log add column if not exists ip_hash text;
create index if not exists user_feedback_ip_created_idx on public.user_feedback (ip_hash, created_at);
create index if not exists client_error_log_ip_created_idx on public.client_error_log (ip_hash, created_at);
