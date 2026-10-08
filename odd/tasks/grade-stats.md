# Feature: grade statistics and graded-task alerts

Objective: an "Estadisticas" menu entry that fetches every enrolled course's grades from Moodle and shows, per course, the points earned out of 100, how many points are still missing to reach the 70-point passing mark, and whether 70 is still reachable. It also sends a push notification when a task gets graded.

Decision (user, 2026-10-08): no mid-cycle/end-of-cycle split; only the 100-point total with 70 to pass.

Route: workflow (Opus high plans and reviews; Sonnet writes the worker/SQL/notification code; Haiku writes the web UI). Branch: feat/grade-stats (base 5f62f6b).

## Tasks
- [x] Plan (Opus high)
- [x] T1 SQL table moodle_grade_items + Supabase client grade methods (sonnet, delegated) - commit: feat(db): add the moodle_grade_items table and its Supabase client methods
- [ ] T2 Moodle grade fetch in moodle_api.py (sonnet, delegated)
- [ ] T3 Grade sync, graded-task alerts and the api_sync hook (sonnet, delegated)
- [ ] T4 Web grade computation and data access (sonnet, delegated)
- [ ] T5 Web Estadisticas page, nav tab and loading skeleton (haiku, delegated)
- [ ] Review and fix

## Design (from the plan)
- Data = Supabase table moodle_grade_items (section 12), one row per (user_id, course_id, item_id), raw grade-report fields, hidden items never stored, RLS + moodle_app_all, ON DELETE CASCADE, no SQLite mirror (the web reads Supabase).
- Fetch = MoodleApiClient.fetch_course_grades, gradereport_user_get_grade_items per current course, at most once per SWEEP_TTL_SECONDS per user, course list shared with the course sweep, per-course errors skip only that course.
- Computation = web/lib/grades.ts (pure): effective weights when complete and not renormalized, else leaf points summing to 100, else course total scaled to 100 marked as estimate; passed >= 70, lost when 70 is unreachable, at risk when more than 70 % of the remaining points are needed.
- Alerts = grades_sync.sync_user_grades: graded mod/manual item whose grade differs from notified_grade; first fetch of a course baselines silently; dedupe by notified_grade (durable) + local milestone grade:<user>:<course>:<item>/<grade>; deliver_to_user kind 'task', url /estadisticas, at most 10 per run; never affects the task sync result.
- Web = tab Estadisticas (short Notas), Mi cuenta short label Cuenta.

## Checks
python -m pytest -q; cd web && npm test && npx tsc --noEmit && npm run build (dummy env)
