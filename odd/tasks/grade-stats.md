# Feature: grade statistics and graded-task alerts

Objective: an "Estadisticas" menu entry that fetches every enrolled course's grades from Moodle and shows, per course, the points earned out of 100, how many points are still missing to reach the 70-point passing mark, and whether 70 is still reachable. It also sends a push notification when a task gets graded.

Decision (user, 2026-10-08): no mid-cycle/end-of-cycle split; only the 100-point total with 70 to pass.

Route: workflow (Opus high plans and reviews; Sonnet writes the worker/SQL/notification code; Haiku writes the web UI). Branch: feat/grade-stats (base 5f62f6b).

## Tasks
- [x] Plan (Opus high)
- [x] T1 SQL table moodle_grade_items + Supabase client grade methods (sonnet, delegated) - commit: feat(db): add the moodle_grade_items table and its Supabase client methods
- [x] T2 Moodle grade fetch in moodle_api.py (sonnet, delegated) - commit: feat(worker): fetch every current course's grade items from Moodle once per sweep cadence
- [x] T3 Grade sync, graded-task alerts and the api_sync hook (sonnet, delegated) - commit: feat(worker): store grade items and alert when a task gets graded
- [x] T4 Web grade computation and data access (sonnet, delegated) - commit: feat(web): compute the 100-point course standing from the stored grade items
- [x] T5 Web Estadisticas page, nav tab and loading skeleton (haiku, delegated) - commit: feat(web): add the Estadisticas page with per-course standing and a nav tab
- [x] Review and fix (opus review, sonnet fix, delegated) - commit db7a424 fix(web): do not confirm a pass from an estimate while activities are pending
- [x] T6 Keep the grades of finished courses still enrolled (inline; user asked for no delegation from here on) - commit 857b9b2
- [x] T7 SQL sections 13 moodle_manual_grades and 14 moodle_avatars (inline) - commit fab0e90
- [x] T8 Manual mid-cycle / end-of-cycle exam grades: math, validation, server actions, card UI (inline) - commit dbd696b
- [x] T9 Account menu behind a profile photo (Mi cuenta, Admin, Cerrar sesion last), four tabs only, photo upload in Mi cuenta (inline) - commit ec12ee7

## Design (from the plan)
- Data = Supabase table moodle_grade_items (section 12), one row per (user_id, course_id, item_id), raw grade-report fields, hidden items never stored, RLS + moodle_app_all, ON DELETE CASCADE, no SQLite mirror (the web reads Supabase).
- Fetch = MoodleApiClient.fetch_course_grades, gradereport_user_get_grade_items per current course, at most once per SWEEP_TTL_SECONDS per user, course list shared with the course sweep, per-course errors skip only that course.
- Computation = web/lib/grades.ts (pure): effective weights when complete and not renormalized, else leaf points summing to 100, else course total scaled to 100 marked as estimate; passed >= 70, lost when 70 is unreachable, at risk when more than 70 % of the remaining points are needed.
- Alerts = grades_sync.sync_user_grades: graded mod/manual item whose grade differs from notified_grade; first fetch of a course baselines silently; dedupe by notified_grade (durable) + local milestone grade:<user>:<course>:<item>/<grade>; deliver_to_user kind 'task', url /estadisticas, at most 10 per run; never affects the task sync result.
- Web = tab Estadisticas (short Notas). The tab bar now has four tabs; Mi cuenta and Admin moved into the account menu.
- Manual exams (user request) = moodle_manual_grades, one row per (user, course, kind midterm|final), 15 points by default. A grade linked to an ungraded Moodle item replaces it (same weight); Moodle wins once it grades that item; an unlinked grade is a fixed block and the Moodle part is scaled to 100 - blocks. grade NULL means "it is that Moodle item" (with a link) or "this course has no such exam" (no link). The card asks "Ya diste tu examen de ...? Agregalo" while missing.
- Profile photo = moodle_avatars data URL (WebP/JPEG/PNG only, signature checked, <= 150000 chars, resized to 256px in the browser); served by GET /api/avatar for the session user only, versioned by the httpOnly avatar_v cookie.

## Verification
- python -m pytest -q: 858 passed, 1 skipped (after T6); schema tests 77 passed (after T7).
- cd web && npm test: 54 files, 686 tests passed; npx tsc --noEmit clean; npm run build (dummy env) compiled, /api/avatar and /estadisticas built (after T9).
- Not verified: visual check of the header/menu and the exam forms on a real phone (needs a deployed build).

## Deploy notes
1. Run the whole supabase_schema.sql as postgres (adds sections 12, 13, 14; idempotent).
2. VPS worker: git pull, pm2 startOrReload deploy/ecosystem.config.js, pm2 save.
3. Vercel: deploy the web.

## Checks
python -m pytest -q; cd web && npm test && npx tsc --noEmit && npm run build (dummy env)
