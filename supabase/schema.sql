-- Kroft's Supabase schema.
--
-- Kroft.jsx's persistence contract is window.storage.get(key)/set(key,value):
-- nine JSON blobs, one per feature area (profile, finance, productivity,
-- calendar, contacts, projects, chat, wellness, emails). This table backs
-- that contract directly with per-user rows, rather than normalizing each
-- feature area into its own relational schema — so none of the existing
-- feature code in Kroft.jsx needs to change, only the storage shim
-- (src/storageShim.js) that implements window.storage on top of it.
--
-- Applied to the "kroft" Supabase project via mcp__Supabase__apply_migration.
-- This file is the reference copy for reproducing it elsewhere (a fresh
-- project, CI, another environment) — it is not run automatically.
create table if not exists public.kv_store (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

comment on table public.kv_store is
  'Per-user JSON blob storage backing Kroft.jsx''s window.storage.get/set contract. One row per (user, feature-area key).';

alter table public.kv_store enable row level security;

-- Each user can only ever see or touch their own rows. auth.uid() comes from
-- the caller's verified JWT (set by Supabase Auth), not from anything the
-- client sends directly — it's the real security boundary here, not the
-- anon/publishable key shipped to the browser.
create policy "kv_store_select_own" on public.kv_store
  for select using (auth.uid() = user_id);

create policy "kv_store_insert_own" on public.kv_store
  for insert with check (auth.uid() = user_id);

create policy "kv_store_update_own" on public.kv_store
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "kv_store_delete_own" on public.kv_store
  for delete using (auth.uid() = user_id);

-- Keeps updated_at accurate on every write without every call site having to
-- remember to set it themselves. search_path is pinned explicitly (rather
-- than left mutable) per Supabase's function-search-path-mutable advisory.
create or replace function public.kv_store_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger kv_store_set_updated_at
  before update on public.kv_store
  for each row
  execute function public.kv_store_set_updated_at();

-- Stores OAuth tokens for third-party integrations (Google/Gmail/Calendar today).
-- Deliberately has NO policies granting the anon/authenticated roles any access at all —
-- RLS is enabled with an empty policy set, which means "no access" by default in Postgres.
-- Access token contents (which could be used to impersonate the user against Google's API)
-- must never be readable from the browser via the publishable key; every read/write here
-- goes through Vercel serverless functions using the service_role key, which bypasses RLS
-- by design and is never exposed to the client. Client code only ever learns a yes/no
-- connected status via api/google/status.js, never the tokens themselves.
create table if not exists public.oauth_tokens (
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null,
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz not null,
  scope         text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, provider)
);

comment on table public.oauth_tokens is
  'Server-only OAuth token storage for third-party integrations. No RLS policies for anon/authenticated — accessible only via service_role from Vercel functions (api/google/*, api/gmail/*, api/calendar/*).';

alter table public.oauth_tokens enable row level security;

create or replace function public.oauth_tokens_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger oauth_tokens_set_updated_at
  before update on public.oauth_tokens
  for each row
  execute function public.oauth_tokens_set_updated_at();

-- Tracks KROFT Plus subscription status per user, kept in sync exclusively by Stripe's webhook
-- (api/billing/webhook.js) via the service_role key. A user can read their own row (this is
-- just a status string and dates, not sensitive the way an OAuth token is), but has no
-- insert/update/delete access at all — "subscribed" can only ever become true because Stripe
-- confirmed a real payment, never because a client set a flag.
create table if not exists public.subscriptions (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id    text,
  stripe_subscription_id text,
  status                text not null default 'inactive',
  current_period_end    timestamptz,
  updated_at            timestamptz not null default now()
);

comment on table public.subscriptions is
  'KROFT Plus subscription status per user. Written only by api/billing/webhook.js via service_role — never by the client. Readable by the owning user (status/dates only, no payment details).';

alter table public.subscriptions enable row level security;

create policy "subscriptions_select_own" on public.subscriptions
  for select using (auth.uid() = user_id);

create or replace function public.subscriptions_set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row
  execute function public.subscriptions_set_updated_at();
