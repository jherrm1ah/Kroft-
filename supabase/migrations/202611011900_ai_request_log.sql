-- AI cost measurement: one row per AI request, with token counts and timing. No message text,
-- prompt or reply is stored. Written only by api/chat.js (service role). Rows older than 90 days
-- are deleted daily by api/cron/deliver-notifications.js.
--
-- Additive only: two new tables and two views. Nothing existing is changed.

create table if not exists public.ai_request_log (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  user_id         uuid references auth.users(id) on delete cascade,  -- null in local-only mode
  plan            text,          -- 'free' | 'plus' at the time of the request
  usage_type      text not null, -- the X-Kroft-Usage-Type pool: chat, voice, report, transcribe, ...
  model           text not null,
  streamed        boolean not null default false,
  input_tokens    integer,       -- Gemini usageMetadata.promptTokenCount
  output_tokens   integer,       -- candidatesTokenCount (the visible reply)
  thinking_tokens integer,       -- thoughtsTokenCount (billed as output)
  cached_tokens   integer,       -- cachedContentTokenCount (billed at a discount)
  latency_ms      integer,       -- request start to last byte
  status          integer not null,  -- HTTP status KROFT returned
  error           text,          -- short error code when status is not 200; never message text
  system_chars    integer,       -- size of the instructions + context sent, to see what drives cost
  client          text           -- X-Kroft-Client: website or app version (no personal data)
);

comment on table public.ai_request_log is
  'One row per AI request for cost measurement: tokens, model, timing, plan. No message content. Service role only; rows older than 90 days are deleted daily.';

create index if not exists ai_request_log_created_at_idx on public.ai_request_log (created_at);
create index if not exists ai_request_log_user_created_idx on public.ai_request_log (user_id, created_at);

-- No policies: only the server (service role) can read or write it.
alter table public.ai_request_log enable row level security;

-- Price per million tokens, in US dollars, per model. Editable without a deploy when Google
-- changes prices; the views below use it to estimate cost.
create table if not exists public.ai_model_prices (
  model                 text primary key,
  input_per_million     numeric not null,
  output_per_million    numeric not null,   -- also applies to thinking tokens
  cached_per_million    numeric,            -- null = same as input
  updated_at            timestamptz not null default now(),
  note                  text
);

alter table public.ai_model_prices enable row level security;

-- Starting values. Published prices for gemini-3.6-flash disagree between sources ($0.75/$3.75
-- vs $1.50/$7.50); the higher figure is used so estimates err on the side of caution. Check
-- https://ai.google.dev/gemini-api/docs/pricing and update these rows.
insert into public.ai_model_prices (model, input_per_million, output_per_million, cached_per_million, note) values
  ('gemini-3.6-flash',      1.50, 7.50, 0.375, 'Conservative: sources disagree. Verify on Google''s pricing page.'),
  ('gemini-2.5-flash',      0.30, 2.50, 0.075, null),
  ('gemini-2.5-flash-lite', 0.10, 0.40, 0.025, null)
on conflict (model) do nothing;

-- Daily totals by feature, model and plan, with estimated cost in dollars.
create or replace view public.ai_cost_daily with (security_invoker = true) as
select
  date_trunc('day', l.created_at)::date as day,
  l.usage_type,
  l.model,
  l.plan,
  count(*)                                         as requests,
  count(*) filter (where l.status <> 200)          as failed,
  count(distinct l.user_id)                        as users,
  sum(l.input_tokens)                              as input_tokens,
  sum(l.output_tokens)                             as output_tokens,
  sum(l.thinking_tokens)                           as thinking_tokens,
  round(avg(l.latency_ms))                         as avg_latency_ms,
  round(avg(l.system_chars))                       as avg_system_chars,
  round(sum(
      (coalesce(l.input_tokens, 0) - coalesce(l.cached_tokens, 0)) * p.input_per_million
    + coalesce(l.cached_tokens, 0) * coalesce(p.cached_per_million, p.input_per_million)
    + (coalesce(l.output_tokens, 0) + coalesce(l.thinking_tokens, 0)) * p.output_per_million
  ) / 1e6, 4)                                      as est_cost_usd,
  round(sum(
      (coalesce(l.input_tokens, 0) - coalesce(l.cached_tokens, 0)) * p.input_per_million
    + coalesce(l.cached_tokens, 0) * coalesce(p.cached_per_million, p.input_per_million)
    + (coalesce(l.output_tokens, 0) + coalesce(l.thinking_tokens, 0)) * p.output_per_million
  ) / 1e6 / nullif(count(*), 0), 6)                as est_cost_per_request_usd
from public.ai_request_log l
left join public.ai_model_prices p on p.model = l.model
group by 1, 2, 3, 4;

-- Per person per month: how spend is spread across users (are a few heavy users most of it?).
create or replace view public.ai_cost_per_user_monthly with (security_invoker = true) as
select
  to_char(date_trunc('month', l.created_at), 'YYYY-MM') as month,
  l.user_id,
  max(l.plan)                                       as plan,
  count(*)                                          as requests,
  round(sum(
      (coalesce(l.input_tokens, 0) - coalesce(l.cached_tokens, 0)) * p.input_per_million
    + coalesce(l.cached_tokens, 0) * coalesce(p.cached_per_million, p.input_per_million)
    + (coalesce(l.output_tokens, 0) + coalesce(l.thinking_tokens, 0)) * p.output_per_million
  ) / 1e6, 4)                                       as est_cost_usd
from public.ai_request_log l
left join public.ai_model_prices p on p.model = l.model
group by 1, 2;

-- The views run with the caller's rights (security_invoker), so the tables' RLS already hides
-- them from app users; revoking makes that explicit.
revoke all on public.ai_cost_daily, public.ai_cost_per_user_monthly from anon, authenticated;
revoke all on public.ai_request_log, public.ai_model_prices from anon, authenticated;
