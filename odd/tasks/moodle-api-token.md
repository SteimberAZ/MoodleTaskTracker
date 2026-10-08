# Feature: Moodle API token + self-hosted Supabase

## Objective
Replace the fragile `MoodleSession` cookie with an official Moodle mobile web-service token obtained
once from the web app, and move all project tables to the self-hosted Supabase on the VPS
(`supabase.mineral-ec.com`) under the `moodle_` prefix (shared database).

## Evidence
- UTM Moodle public config: `typeoflogin=1` (in-app username/password, no SSO),
  `enablemobilewebservice=1`; `login/token.php` responds.
- Existing tables in Supabase: `moodle_tasks`, `moodle_task_milestones`.
- VPS: worker runs under pm2 (`utm-moodle-tracker`) in `/home/steimber/utm-moodle-tracker` (no git).

## Decisions
- Password is never stored or logged: web server exchanges it for a token via `login/token.php`.
- Tables: `moodle_tasks`, `moodle_task_milestones`, `moodle_settings`, `moodle_custom_reminders`
  (optional `task_id` FK -> `moodle_tasks`), `moodle_credentials` (single row).
- All `moodle_*` tables: RLS on, no anon policies (service-role only). Fixes cookie exposure.
- Worker prefers API token; falls back to cookie scraping only if no token is configured.

## TDD
- Mode: off (no project config). Runners: `python -m pytest -q`, `npm test` / `npm run build` in `web/`.

## Delivery
- Branch `feat/moodle-api-token`. RDD off. Push/merge per explicit user decision.

## Tasks
- [x] T1 Schema rewrite + Python API client + worker wiring + tests. Route: delegated (2+ files). Commits `901995b`, `42a57fd`; pytest 72 passed. Untested against live UTM Moodle.
- [x] T1b Target DB = Mineral shared Supabase; role `moodle_app` (NOLOGIN) + RLS policy `moodle_app_all`, anon/authenticated revoked; client sends `apikey`=ANON + `Bearer`=MOODLE_DB_JWT (legacy service-role chain kept); `scripts/make_moodle_jwt.py`. Commit `37fe025`; pytest 79 passed. Schema not yet run on the live DB.
- [x] T2 Web: `/moodle` connect page (token.php + get_site_info, upsert/delete `moodle_credentials`), `lib/db.ts` helper (anon apikey + MOODLE_DB_JWT bearer, service-role fallback), `moodle_custom_reminders` rename + optional `task_id` link. Route: delegated. Commit `0267362`; npm test 45 passed, tsc clean, next build OK. Untested against live Moodle/DB.
- [ ] T3 README + VPS deployment instructions (prompt for the VPS Claude). Route: inline.

## Progress / Evidence

## Next step
- T1
