# Feature: Submission detection + custom reminders web

## Objective
1. Stop Moodle task reminders once the assignment has been submitted.
2. Add a password-protected web app (deployable to Vercel) where the owner creates custom
   reminders with a repeat interval and an end date; the VPS worker delivers them via ntfy.

## Problem / Why
- `moodle_client.py:193` infers `submitted` from calendar-card text, which rarely shows
  submission state, so submitted tasks keep triggering reminders.
- Vercel cannot reach the VPS SQLite; Supabase (already configured on the VPS) is the shared store.

## Scope / Constraints
- Python worker stays the delivery engine (ntfy). Web never sends notifications itself.
- Web: Next.js in `web/`, single password from env `APP_PASSWORD`, Supabase accessed only
  server-side with the service-role key. No secrets committed.
- New table `custom_reminders` has RLS enabled with NO public policies (service role only).
- Timezone: America/Guayaquil for display.
- Do not push / open PR / merge without the user's decision (AGENTS.md: never touch `main`).

## Decisions
- Auth: single shared password (user choice), signed HTTP-only session cookie.
- Submission check: scrape `/mod/assign/view.php?id=<cmid>` for each pending task and parse the
  submission-status table ("Enviado para calificar" / "Submitted for grading").

## TDD
- Mode: off (source: no project/session config; no tests existed). Runner: `python -m pytest`
  for new unit tests; `npm run build` for the web.

## Delivery
- Strategy: ask-on-risk (default). Forecast ~900 authored lines (> 400) -> chain strategy to be
  asked before opening any PR. RDD: off (default) -> ordinary checks only.

## Tasks
- [x] T1 Reliable submission detection (moodle_client + notifier skip + tests). Route: delegated (2+ non-trivial files). Commit `90dbb47`.
- [x] T2 `custom_reminders` schema + worker delivery of custom reminders via ntfy + tests. Route: delegated. Commit `c7f0034`.
- [x] T3 Next.js web app in `web/` (login, list/create/edit/delete reminders). Route: delegated. Commit `3cca76c`.
- [x] T4 Docs: README deploy steps (Vercel env vars, Supabase SQL, VPS env). Route: inline. Commit `70531d3`.

## Acceptance criteria
- Submitted assignments never produce new task reminders after the next sync.
- A reminder created in the web fires on the VPS every N minutes/hours/days between start and end date, then stops.
- Web refuses all reads/writes without the password session.

## Progress / Evidence
- Branch: `feat/submission-detection-and-reminders-web`
- `python -m pytest -q`: 42 passed. `npm test` (web): 25 passed. `npm run build` + `tsc --noEmit`: ok.
- RDD off -> no native review. Not verified end-to-end against real Moodle/Supabase.
- Known pre-existing gap: `supabase_client.py` writes `moodle_tasks`/`moodle_settings`/`moodle_task_milestones`, while the schema file defines `tasks`/`settings`/`task_milestones`.

## Next step
- User: run SQL, set env vars (VPS + Vercel), deploy. Push/PR is the user's decision (chain strategy to ask).
