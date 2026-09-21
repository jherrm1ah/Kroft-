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
