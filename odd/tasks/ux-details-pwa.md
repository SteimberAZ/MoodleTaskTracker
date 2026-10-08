# Feature: UX pass — task details, mute, pagination, responsive, PWA icons

## Objective
Make the web comfortable on phones and desktop: compact paginated task list, a detail view with
course/teacher/description, per-user "mute task", a better dark-friendly favicon, and proper
home-screen icons on iOS/Android (no generic "M").

## Decisions (defaults, no open product questions)
- Mute = `moodle_tasks.is_dismissed = 1` set from the web; muted tasks get no notifications and are
  hidden from the default list (filter "Silenciadas" to see/restore them).
- Worker must NEVER overwrite `is_dismissed` from its local SQLite; Supabase is the source of truth.
- New task detail columns: `description` (plain text), `course_id`, `module`, `teachers` (jsonb array
  of names), `details_updated_at`.
- Teachers come from Moodle course contacts (`core_course_get_courses_by_field`), cached per course.
- Pagination: 8 tasks per page, 8 reminders per page, `?tp=` / `?rp=` query params.
- PWA: `app/manifest.ts`, PNG icons 192/512 (+ maskable), `apple-touch-icon` 180, theme colors.
- No responsive skill is installed; apply mobile-first rules (44px targets, fluid type, no h-scroll).
- Web Push (user decision 2026-10-08): native push to the installed PWA is the primary channel
  (refs: Next.js PWA guide, WebKit "Web Push for Web Apps on iOS" — iOS 16.4+, home screen only,
  user-gesture permission; pywebpush). VAPID private key only on the VPS; web gets the public key.
  Web "Enviar prueba" sets `test_requested_at`; the worker sends it. ntfy stays only in /cuenta as
  before, with toggle `moodle_users.ntfy_enabled`. The "Activa las notificaciones" banner/page must
  not mention ntfy.

## TDD
- Mode: off. Runners: `python -m pytest -q`; `npm test`, `npx tsc --noEmit`, `npm run build` in `web/`.

## Delivery
- Branch `feat/ux-details-pwa` from main `a58daed`. RDD off. Push to main only with user OK.

## Tasks
- [x] T1 Worker + schema: detail columns, teachers, respect web mute. Route: delegated (python). Commit ad60cb7; `python -m pytest -q`: 150 passed (132 + 18 new); `python -c "import worker"`: ok. Also added `moodle_users.notify_confirmed_at timestamptz`.
- [x] T2 Web: compact cards, pagination, detail page, mute toggle, responsive pass, Web Push client + `/api/push/*`, `/notificaciones`, ntfy toggle in /cuenta. Route: delegated (web). Not committed yet (parent commits). `npm test`: 21 files, 184 passed; `npx tsc --noEmit`: clean; `npm run build` (dummy env): ok, 15 routes. Smoke on `next start` + a throwaway fake PostgREST: logged-out `/login`, `/manifest.webmanifest`, `/sw.js`, icons 200; `/` -> 307 `/login`; `/api/push/*` logged out -> JSON 401; same-origin/size/JSON/endpoint checks -> 403/413/415/400; subscribe/resubscribe/test/unsubscribe scoped by `user_id`. Edge headless over CDP (real service worker, faked PushManager): iOS-browser -> "agrega a pantalla de inicio", iOS-standalone/Android/desktop -> activar -> activas -> prueba -> desactivar, denied instructions, "¿No te llegan?" per platform. 320 px audit on `/`, detalle, cuenta, notificaciones, reminders/new, admin: no horizontal scroll, inputs >= 16 px, targets >= 44 px. NOT verified: a real push delivery (needs FCM/APNs and the VPS worker) and the migrated schema (SQL not run against Postgres).
- [x] T3 Brand: dark-friendly favicon, PWA manifest + PNG icons, apple-touch-icon. Route: delegated with T2. `app/icon.svg` redesigned (clay gem + mortarboard, dark/light via `prefers-color-scheme`); `app/manifest.ts`; `web/scripts/generate-icons.mjs` (`npm run icons`, devDependency `sharp`) writes `public/icons/icon-192.png` (2825 B), `icon-512.png` (7367 B), `icon-maskable-512.png` (4564 B), `apple-touch-icon.png` 180 (1669 B, also copied to `public/apple-touch-icon.png`) and `badge-96.png` (917 B, white on transparent, for Android push). Middleware matcher now skips `api/`, `sw.js`, `manifest.webmanifest`, `apple-touch-icon.png`, `icons/`, `brand/`.
- [x] T4 README deploy notes (VAPID, venv, Vercel public key). Route: inline. VPS + Vercel steps handed to the user.
- [x] T5 Web Push delivery (worker). Route: delegated (python). Commit 902dbc1; `python -m pytest -q`: 293 passed, 1 skipped (150 existing + 143 new; the skip is a POSIX-only file-mode test); `python -c "import worker"`: ok, also in a clean venv holding only `requirements-worker.txt`; `python scripts/generate_vapid.py --out <tmp>`: 87-char public key + `NEXT_PUBLIC_VAPID_PUBLIC_KEY=` line, second run refused (exit 2), test key deleted. SQL not executed against a live Postgres (reviewed only).

## Progress / Evidence
- T5 done (commit 902dbc1, 17 files, +2460/-100 of which ~1460 are test lines; one commit as requested, over the 400-line review budget). Contract for the web:
  * `moodle_push_subscriptions` as specified; the web upserts on `endpoint`. The worker maintains `last_success_at`, `last_failure_at`, `failure_count`; it deletes the row on HTTP 404/410 and on the 10th consecutive HTTP failure (network errors on the VPS side and VAPID/config errors are NOT counted, so an outage cannot wipe subscriptions).
  * Payload `{title, body, url, tag}` (<= 3.5 KB). `url` is a path inside the PWA: `/tareas/<task_id>` (milestones), `/` (custom reminders, class reminders, "Moodle desconectado"), `/notificaciones` (test). Tags: `task-<id>`, `reminder-<id>`, `class-<id>`, `moodle-status`, `test`. Urgency `high` for urgent/high priorities; TTL 24 h tasks/alerts, 6 h reminders, 30 min class reminders, 10 min test.
  * "Enviar prueba": the web sets `test_requested_at`; the worker answers within ~60 s and clears it (also when the send failed).
  * `moodle_users.ntfy_enabled` (default true) is read by the worker; Web Push and ntfy are independent channels and a delivery counts when at least one accepted it (otherwise the milestone/reminder is retried on the next round). The worker also runs before the SQL is re-run: a missing table/column is logged once and ntfy keeps working.
  * VPS env: `VAPID_PRIVATE_KEY_FILE` (default `./vapid_private.pem`) or `VAPID_PRIVATE_KEY`; `VAPID_SUBJECT=mailto:<real email>` (falls back to `mailto:admin@localhost` with a warning). Vercel env: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` only (baked at build time, so redeploy). README and `.env.example` still need these variables (outside T5 scope).
  * Deploy order: stop worker -> run `supabase_schema.sql` -> `git pull` -> venv + `pip install -r requirements-worker.txt` -> `python scripts/generate_vapid.py` (copy the public key to Vercel) -> `VAPID_SUBJECT` in `.env` -> start the worker with the venv interpreter -> redeploy Vercel.

## Next step
- VPS: stop worker, pull, run SQL, venv + requirements-worker.txt, generate VAPID, VAPID_SUBJECT, start with venv interpreter.
- Vercel: set NEXT_PUBLIC_VAPID_PUBLIC_KEY and redeploy. Root `.env.example` could not be edited (deny rule); README documents the vars.
