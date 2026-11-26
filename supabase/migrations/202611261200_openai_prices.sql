-- Kroft's AI moved from Google Gemini to OpenAI (api/_lib/openai.js). Prices per million tokens
-- in US dollars, used by the ai_cost_daily view to estimate spend. Starting values from
-- OpenAI's published pricing; check https://openai.com/api/pricing and update these rows.
-- The old Gemini rows stay so past requests still have a cost.
insert into public.ai_model_prices (model, input_per_million, output_per_million, cached_per_million, note) values
  ('gpt-4.1-mini',           0.40, 1.60, 0.10,  'Default chat model. Verify on OpenAI''s pricing page.'),
  ('gpt-4o-mini-transcribe', 1.25, 5.00, null,  'Voice notes. Verify on OpenAI''s pricing page.')
on conflict (model) do nothing;
