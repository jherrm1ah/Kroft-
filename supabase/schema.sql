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

-- Tracks KROFT Plus subscription status per user, kept in sync exclusively by Flutterwave's
-- webhook and post-checkout verification (api/billing/webhook.js, api/billing/callback.js) via
-- the service_role key. A user can read their own row (this is just a status string and dates,
-- not sensitive the way an OAuth token is), but has no insert/update/delete access at all —
-- "subscribed" can only ever become true because Flutterwave confirmed a real payment, never
-- because a client set a flag.
--
-- Provider was originally Stripe; switched to Flutterwave since Stripe doesn't support payouts
-- to Nigerian bank accounts, so it was never usable for this app's actual merchant. No real
-- subscribers existed yet, so the provider-specific columns were renamed in place rather than
-- migrated.
create table if not exists public.subscriptions (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  provider                text not null default 'flutterwave',
  provider_customer_ref   text, -- Flutterwave identifies customers by email, not a dedicated customer-id concept
  provider_subscription_id text, -- known only after the first successful recurring charge — null before then
  status                  text not null default 'inactive',
  current_period_end      timestamptz,
  updated_at              timestamptz not null default now(),
  -- Whether the payment method behind the current/last successful charge is one Flutterwave will
  -- auto-recharge next cycle (currently: card only — see isRecurringCapablePayment in
  -- api/_lib/flutterwave.js). false means the user must manually resubscribe before
  -- current_period_end (e.g. they paid by bank transfer, USSD, or mobile money).
  auto_renews             boolean not null default false
);

comment on table public.subscriptions is
  'KROFT Plus subscription status per user. Written only by api/billing/webhook.js and api/billing/callback.js via service_role — never by the client. Readable by the owning user (status/dates only, no payment details). Provider: Flutterwave.';

comment on column public.subscriptions.status is
  'inactive (never subscribed) | active | past_due (a renewal charge failed — not treated as subscribed) | canceled.';

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

-- Idempotency ledger for Flutterwave charge processing (see
-- api/_lib/flutterwave.js's claimTransactionForProcessing). One row per Flutterwave transaction
-- id, inserted exactly once via ON CONFLICT DO NOTHING (an atomic claim, not check-then-act) —
-- the same transaction can never be applied twice regardless of how many times
-- api/billing/callback.js's redirect-driven verify and api/billing/webhook.js's event delivery
-- overlap or retry. Server-only, same access pattern as oauth_tokens: RLS enabled with no
-- policies, so only service_role can read or write it.
create table if not exists public.payment_events (
  transaction_id text primary key,
  user_id        uuid references auth.users(id) on delete set null,
  event_type     text not null,
  status         text not null,
  processed_at   timestamptz not null default now()
);

comment on table public.payment_events is
  'Idempotency ledger for Flutterwave charge processing (see api/_lib/flutterwave.js''s claimTransactionForProcessing). One row per transaction id, inserted exactly once via ON CONFLICT DO NOTHING — the same transaction can never be applied twice regardless of how many times callback/webhook delivery overlaps or retries. Service_role only, same as oauth_tokens.';

alter table public.payment_events enable row level security;

-- Server-side backing for KROFT's AI usage limits (see api/chat.js). Only usage_types that have
-- a row in plan_limits (below) for the caller's plan are ever counted here — chat, extra (AI
-- drafts/suggestions) and report are genuinely unlimited on every plan and never touch this
-- table at all. The one client-side counter that still mirrors a real limit (voiceTurnsCount,
-- for instant UI feedback) lives in kv_store, which the account owner can write directly via
-- RLS — so it's display-only; this table plus increment_ai_usage() below are the real,
-- unspoofable enforcement point.
create table if not exists public.ai_usage (
  user_id    uuid not null references auth.users(id) on delete cascade,
  usage_type text not null, -- 'voice' | 'location_search' | any future metered type
  period     text not null, -- 'YYYY-MM-DD' for daily types, 'YYYY-MM' for monthly types
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_type, period)
);

comment on table public.ai_usage is
  'Server-side, unspoofable counters backing KROFT''s free-tier AI usage limits (see api/chat.js and increment_ai_usage()). Written only via increment_ai_usage, called by api/chat.js using service_role. No RLS policies for anon/authenticated — same access pattern as oauth_tokens/payment_events.';

alter table public.ai_usage enable row level security;

-- Atomic claim-a-unit-of-quota operation: a single INSERT ... ON CONFLICT DO UPDATE avoids the
-- race a plain select-then-upsert would have (two concurrent requests both reading "4 used,
-- limit 5" and both proceeding, over-granting quota) — the same reasoning as
-- claimTransactionForProcessing in api/_lib/flutterwave.js, applied to counting up instead of
-- claiming a single id. Ordinary SECURITY INVOKER (the default, no DEFINER) is used since there's
-- no need to escalate privilege here.
create or replace function public.increment_ai_usage(p_user_id uuid, p_usage_type text, p_period text)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  new_count integer;
begin
  insert into public.ai_usage (user_id, usage_type, period, count, updated_at)
  values (p_user_id, p_usage_type, p_period, 1, now())
  on conflict (user_id, usage_type, period)
  do update set count = public.ai_usage.count + 1, updated_at = now()
  returning count into new_count;
  return new_count;
end;
$$;

-- IMPORTANT: Supabase grants EXECUTE on every new public-schema function to anon/authenticated by
-- default, independent of the `public` pseudo-role — revoking from `public` alone does NOT
-- remove this. Without the explicit revoke below, any signed-in (or even anonymous) caller could
-- invoke this RPC directly with an arbitrary p_user_id and grief another user's quota.
revoke execute on function public.increment_ai_usage(uuid, text, text) from public, anon, authenticated;
grant execute on function public.increment_ai_usage(uuid, text, text) to service_role;

-- The configurable source of truth for every AI usage limit — api/chat.js and api/usage.js both
-- read this table instead of hardcoding numbers, so an allowance can be changed (or a brand new
-- metered feature turned on) by editing a row here, with no code change or redeploy. A usage_type
-- with NO row for a given plan is unlimited by construction: that's how chat, extra (AI drafts &
-- suggestions) and report stay genuinely uncapped on every plan, matching the product principle
-- that ordinary text usage is never the thing being rationed — only features with a real,
-- separate infrastructure/API cost (voice, location search, and the not-yet-built vision/image
-- generation/file analysis/web research/background AI/advanced-agent features below) are.
create table if not exists public.plan_limits (
  plan        text not null,    -- 'free' today; a paid tier can be added later as its own rows
  usage_type  text not null,    -- matches the X-Kroft-Usage-Type header api/chat.js reads
  period      text not null,    -- 'day' | 'month' — which calendar window limit_count resets on
  limit_count integer,          -- null = unlimited for this plan/usage_type (rare — omit the row instead, kept only for documentation)
  label       text not null,    -- human-readable name used in quota messages and any UI meter
  primary key (plan, usage_type)
);

comment on table public.plan_limits is
  'Backend-configurable AI usage allowances per plan. Absence of a (plan, usage_type) row means unlimited. Edit rows here to change an allowance without a code deploy.';

alter table public.plan_limits enable row level security;

-- Public, read-only: the numbers themselves aren't sensitive, and the client needs them (via
-- GET /api/usage) to render an accurate "X of Y left" without a privileged round trip.
create policy plan_limits_select_all on public.plan_limits for select using (true);

insert into public.plan_limits (plan, usage_type, period, limit_count, label) values
  ('free', 'voice',           'day', 30, 'Voice'),
  ('free', 'location_search', 'day', 20, 'Around Me searches'),
  -- The remaining rows are placeholders for features that don't exist in the app yet (no vision,
  -- image generation, file/PDF analysis, web search, background AI or agent call sites exist as
  -- of this migration). Seeded now so each feature's free allowance is already configured the
  -- moment it ships — nothing else here references these usage_type strings yet.
  ('free', 'vision',           'day', 15, 'Vision'),
  ('free', 'image_generation', 'day', 10, 'Image generation'),
  ('free', 'file_analysis',    'day', 10, 'File analysis'),
  ('free', 'web_search',       'day', 10, 'Web research'),
  ('free', 'background_ai',    'day',  5, 'Background AI'),
  ('free', 'agent',            'day',  5, 'Advanced actions')
on conflict (plan, usage_type) do nothing;

-- Real push delivery needs two things this app didn't have: somewhere to remember which
-- browsers are subscribed to push (push_subscriptions), and a queryable index of "what needs to
-- fire and when" a cron job can scan efficiently (scheduled_notifications). Reminder/appointment
-- *content* deliberately stays exactly where it already lives (kv_store, client-managed) — this
-- is not a migration of that data model, just a thin, purpose-built index the client keeps in
-- sync whenever it creates, edits, or deletes something with a fire time. Same RLS pattern as
-- oauth_tokens/payment_events/ai_usage: no policies for anon/authenticated, written and read only
-- by service_role via api/* endpoints.

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null,
  p256dh     text not null,
  auth_key   text not null,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

comment on table public.push_subscriptions is
  'Web Push subscriptions (endpoint + keys) registered by a user''s browser via a service worker. One row per browser/device. Written by api/push/subscribe.js, read only by the cron delivery endpoint, both via service_role.';

alter table public.push_subscriptions enable row level security;

create table if not exists public.scheduled_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- A stable, client-chosen key ("appt:<id>", "brief:2026-09-24") so the client can idempotently
  -- upsert or cancel a scheduled push by re-syncing whenever the underlying appointment/brief
  -- time changes, without needing to track this table's own generated row id.
  client_key text not null,
  fires_at   timestamptz not null,
  title      text not null,
  body       text not null,
  tag        text not null default 'kroft:reminder',
  sent       boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, client_key)
);

comment on table public.scheduled_notifications is
  'A thin, queryable index of "what needs to push and when" — kept in sync by the client whenever an appointment or the daily brief time is created, edited, or deleted. The appointment''s own detail stays in kv_store; this only exists so a cron job can efficiently find what''s due across every user without scanning JSON blobs. Written by api/push/schedule.js, read and marked sent by the cron delivery endpoint, both via service_role.';

alter table public.scheduled_notifications enable row level security;

-- The cron job's whole query is "what fires soon and hasn't been sent" — this is the one access
-- pattern that actually needs an index; everything else here is service_role point-lookups by id.
create index if not exists scheduled_notifications_due_idx
  on public.scheduled_notifications (fires_at) where not sent;
