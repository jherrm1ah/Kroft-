-- Error log: crashes, unexpected errors and failed saves reported by the app (src/errorLog.js via
-- api/log-error.js), so problems are seen before anyone reports them. No personal data: messages
-- and stack traces are cleaned on the device and again on the server (emails, numbers, tokens,
-- links' query strings removed). Rows older than 30 days are deleted daily by
-- api/cron/deliver-notifications.js.
--
-- Additive only: one new table and one view. Nothing existing is changed.

create table if not exists public.client_error_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete cascade,  -- null when not signed in
  kind        text not null,    -- 'error' | 'promise' | 'crash' | 'save'
  message     text not null,    -- cleaned, at most 300 characters
  source      text,             -- file:line:column, without the site's address
  stack       text,             -- cleaned, at most 1500 characters
  path        text,             -- the page path, without query strings
  count       integer not null default 1,   -- times it happened in the batch it came in
  client      text              -- X-Kroft-Client: website or app version and device type
);

comment on table public.client_error_log is
  'Errors reported by the KROFT app (cleaned of personal data). Service role only; rows older than 30 days are deleted daily.';

create index if not exists client_error_log_created_at_idx on public.client_error_log (created_at);

-- No policies: only the server (service role) can read or write it.
alter table public.client_error_log enable row level security;

-- The same error grouped, most frequent first, for the last 7 days.
create or replace view public.client_errors_recent
with (security_invoker = true) as
select kind, message, source,
       sum(count)::int                 as times,
       count(distinct user_id)::int     as people,
       min(created_at)                  as first_seen,
       max(created_at)                  as last_seen,
       (array_agg(client order by created_at desc))[1] as latest_client
from public.client_error_log
where created_at > now() - interval '7 days'
group by kind, message, source
order by times desc;
