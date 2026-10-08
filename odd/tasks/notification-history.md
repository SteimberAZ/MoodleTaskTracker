# Feature: Notification history in "Avisos"

## Objective
Every notification the worker executes for a user (task milestones, custom reminders, class reminders,
"Moodle desconectado" alerts, push tests) is recorded and shown in the Notificaciones/Avisos page.

## Decisions (defaults)
- Table `moodle_notification_log`: one row per delivery attempt to a user (not per device), with
  kind, title, body, url, tag, per-channel outcome (push devices ok/total, ntfy ok/attempted),
  overall status `sent` | `failed`, created_at.
- Both sent and failed attempts are logged; failed ones are shown as "No entregada".
- Retention: 90 days; the worker prunes once a day. Logging never blocks or breaks delivery.
- Web: "Historial" section on /notificaciones, 20 per page, filter by kind, each item links to its url.
  User can clear their own history.

## TDD
- Mode: off. Runners: `python -m pytest -q`; `npm test`, `npx tsc --noEmit`, `npm run build` in `web/`.

## Delivery
- Branch `feat/notification-history` from main `ed4209c`. RDD off. Push + deploy with user OK.

## Tasks
- [x] T1 Schema + worker logging + pruning (python). Route: delegated. Commit `3a00191`; `python -m pytest -q` 388 passed, 1 skipped; `python -c "import worker"` OK.
- [x] T2 Web history UI on /notificaciones (web). Route: delegated. Done (uncommitted): `npm test` 290 passed (27 files), `npx tsc --noEmit` clean, `npm run build` OK. Files: web/lib/notification-log.ts, web/lib/notification-history.ts, web/app/notificaciones/{page.tsx,actions.ts}, web/components/{NotificationHistory,NotificationItem,HistoryFilters,ClearHistoryButton}.tsx, Icons.tsx (CalendarIcon), globals.css, tests/notification-log.test.ts. Missing table (404) renders "El historial estará disponible pronto". Commit: pending.
- [x] T3 Deploy (Vercel deployed; VPS steps handed to the user). Route: inline.

## Progress / Evidence
- T1: buffered per-tick bulk insert (finally), kind passed explicitly by each caller, prune once/24h (local setting `notification_log_pruned_at`). Schema section 10 appended; VPS needs supabase_schema.sql re-run before rows appear (missing table is logged once, delivery unaffected).

## Next step
- VPS: git pull + run supabase_schema.sql + pm2 restart.
