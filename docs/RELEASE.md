# Releasing KROFT

KROFT has one production environment: the website `https://kroft-pied.vercel.app` (Vercel project
`kroft`) with the `kroft` Supabase project behind it. The Android app loads that same website, so
almost every change reaches phones as soon as it is deployed. There is deliberately no separate
staging site or staging database; changes are checked at each step below instead.

## Shipping a change

1. **Branch and pull request.** All work happens on a branch and goes through a pull request.
   Nothing is pushed straight to `main`.
2. **Automatic checks on the pull request** (`.github/workflows/ci.yml`, `android.yml`):
   - `build-and-test`: unit tests (`npm test`) and a production build.
   - `app-shells`: the real build is run as the website, as the first Android APK (build 1, no
     location/fingerprint/file plugins) and as the current APK (`npm run test:e2e`). Catches a
     change that breaks older installed apps.
   - `apk`: builds and verifies the Android APK (only when native files change).
3. **Preview deployment.** Vercel builds every pull request and links it on the PR.
   Previews are protected by Vercel sign-in. Note that **previews use the production database
   and the live payment keys**: test with your own account, and don't make test payments there.
4. **You test and approve.** Merging to `main` is the release.
5. **Production check** (`.github/workflows/production-check.yml`) runs automatically once Vercel
   has deployed: it confirms the new version is the one being served, the app starts without
   errors, the legal and offline pages load, and the API is up and still requires sign-in.
   If it fails, GitHub emails you and the run's summary shows how to roll back.

## Rolling back

The website, and with it the Android app's screens:

1. Open <https://vercel.com/virt-technologies/kroft/deployments>.
2. On the previous Production deployment, open the menu (⋯) and choose **Instant Rollback**.

It takes seconds and needs no rebuild. On Vercel's free plan you can roll back to the previous
production deployment. Phones pick up the rolled-back version the next time KROFT loads (or when
reopened after 10+ minutes away; see `src/webUpdate.js`). Then fix the problem in a new pull
request. Merging it deploys normally.

Database changes are made additive (new tables or columns), so rolling back the website never
needs a database rollback.

## Android app releases

Only changes to the native app need a new APK: a new plugin, permission, icon or Android setting.
Screens and features don't; they come from the website.

1. Raise `VERSION_NAME` in `android/version.properties` in the same pull request
   (`1.1.0` → `1.2.0`). The build number follows automatically (`1.2.0` → `10200`).
2. When the pull request is merged, `android.yml` publishes a GitHub Release `android-v<version>`
   with `KROFT.apk`. The newest APK is always at
   <https://github.com/jherrm1ah/Kroft-/releases/latest/download/KROFT.apk>.
3. It installs over the previous version and keeps the person signed in.

These are test builds signed with KROFT's debug key. Play Store releases (signed AAB, Play
tracks) come later and are a separate workflow.

The website must keep working on older installed APKs: native features check that the
installed app has their plugin (`hasPlugin` in `src/native.js`) and say "update the app"
otherwise. `npm run test:e2e` checks this on every pull request.

## Database changes

- Additive only: new tables, or new columns that are nullable or have defaults. Never rename or
  drop something the live site or an installed app still uses.
- Write the SQL as a dated file in `supabase/migrations/` and update `supabase/schema.sql` to
  match. Row-level security on every new table.
- Applied to the production project only after you approve it.
