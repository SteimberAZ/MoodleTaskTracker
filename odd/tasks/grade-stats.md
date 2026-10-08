# Feature: grade statistics and graded-task alerts

Objective: an "Estadisticas" menu entry that fetches every enrolled course's grades from Moodle and shows, per course, the points earned out of 100, how many points are still missing to reach the 70-point passing mark, and whether 70 is still reachable. It also sends a push notification when a task gets graded.

Decision (user, 2026-10-08): no mid-cycle/end-of-cycle split; only the 100-point total with 70 to pass.

Route: workflow (Opus high plans and reviews; Sonnet writes the worker/SQL/notification code; Haiku writes the web UI). Branch: feat/grade-stats (base 5f62f6b).

## Tasks
- [ ] Plan (Opus high)
- [ ] Implementation tasks: filled in by the plan
- [ ] Review and fix

## Checks
python -m pytest -q; cd web && npm test && npx tsc --noEmit && npm run build (dummy env)
