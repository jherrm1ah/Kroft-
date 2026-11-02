-- Which paid plan a subscription is for: 'plus' or 'pro'. KROFT Pro features (the business's
-- logo on documents, no "Created with KROFT" line) unlock only when this says 'pro' and the
-- subscription is active. Like the rest of subscriptions, only the server (service role) writes it,
-- after a payment is confirmed; people can read their own row as before.
--
-- Every existing subscriber is on Plus, so the default keeps them there. The app works without
-- this column (everyone with an active subscription is treated as Plus) until it's applied.
alter table public.subscriptions
  add column if not exists plan text not null default 'plus';

do $$ begin
  alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('plus', 'pro'));
exception when duplicate_object then null;
end $$;
