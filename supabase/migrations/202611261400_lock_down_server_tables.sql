-- Server-only tables and views: only api/* (service role) reads or writes them. RLS with no
-- policies already blocks the app's anon/signed-in roles; removing their table privileges too
-- means a future policy added by mistake still can't expose them.
revoke all on table
  public.ai_model_prices, public.ai_request_log, public.ai_usage, public.client_error_log,
  public.oauth_tokens, public.payment_events, public.push_subscriptions,
  public.scheduled_notifications, public.user_feedback
from anon, authenticated;
revoke all on public.client_errors_recent, public.ai_cost_daily, public.ai_cost_per_user_monthly from anon, authenticated;

-- rls_auto_enable() is an event-trigger helper (turns RLS on for every new table). Nobody needs
-- to call it through the API.
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
