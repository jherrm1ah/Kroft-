-- In-app feedback (src/feedback.js via api/feedback.js): what someone wrote, what kind it is,
-- which screen they were on and the app version. The signed-in person's email is kept so they
-- can be answered; nothing else about them.
--
-- Additive only: one new table. Nothing existing is changed.

create table if not exists public.user_feedback (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete cascade,  -- null when not signed in
  email       text,             -- to reply to; null when not signed in
  kind        text not null,    -- 'problem' | 'idea' | 'praise'
  message     text not null,    -- at most 2000 characters
  screen      text,             -- where they were, e.g. 'Finance' or 'Workspace › Projects'
  client      text,             -- X-Kroft-Client: website or app version and device type
  done        boolean not null default false   -- tick when it's been dealt with
);

comment on table public.user_feedback is
  'Feedback sent from inside KROFT, with the screen it came from. Service role only.';

create index if not exists user_feedback_created_at_idx on public.user_feedback (created_at desc);

-- No policies: only the server (service role) can read or write it.
alter table public.user_feedback enable row level security;
