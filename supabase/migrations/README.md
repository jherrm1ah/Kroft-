# Database migrations

`../schema.sql` is the full current schema of the production `kroft` Supabase project.

Each change after it goes here as its own file, named `YYYYMMDDHHMM_short_description.sql`, and
is also folded into `schema.sql` so that file always describes the whole database. Changes are
additive (new tables, nullable or defaulted columns), enable row-level security on new tables, and
are applied to production only after the owner approves them. See `docs/RELEASE.md`.
