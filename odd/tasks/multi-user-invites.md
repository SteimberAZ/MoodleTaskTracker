# Feature: Multi-user with invite codes

## Objective
Turn the single-user tracker into an invite-only multi-user app: each user logs in with their UTM
Moodle account, gets their own unguessable ntfy.sh topic, and sees only their own tasks and reminders.

## Why
The owner wants to share the tracker with invited classmates while keeping their own setup
(existing ntfy topic, class schedule reminders).

## Decisions (fixed by the user / parent session)
- Identity = UTM Moodle account (`login/token.php`, service `moodle_mobile_app`, then
  `core_webservice_get_site_info`). Password never stored or logged. Token refreshed on each login.
  `APP_PASSWORD` login is removed; `/moodle` connect page is merged into login.
- Admin bootstrap: env `ADMIN_MOODLE_USERNAME` registers without invite, `is_admin=true`,
  topic = env `ADMIN_NTFY_TOPIC` or random; claims orphan `moodle_custom_reminders` (user_id null).
- New users need a single-use invite code (optional expiry), claimed atomically.
- Random topic `utm-` + ~20 lowercase base32 chars. `/cuenta`: topic, subscribe link, test push,
  regenerate. `/admin`: create/list/revoke invites, list users, active toggle.
- Session cookie `v2.<userId>.<exp>.<hmac>`; every data access scoped by session userId
  (single `moodle_app` DB role; isolation enforced in app code).
- Class schedule reminders stay owner-only via env `NTFY_TOPIC`.
- Legacy cookie path runs only when there are zero active users with tokens.

## Schema contract
- `moodle_users(id uuid pk, moodle_url, site_userid, username, fullname, token, ntfy_topic unique,
  is_admin, active, created_at, last_login_at, last_error, last_error_at, updated_at,
  unique(moodle_url, site_userid))`
- `moodle_invites(code pk, created_by, created_at, expires_at, used_at, used_by)`
- `moodle_tasks.user_id` NOT NULL (old null rows deleted, resynced); task id = md5(`user_id:url`).
- `moodle_custom_reminders.user_id` nullable (worker skips null rows).
- `moodle_credentials` deprecated, left in place.

## Coordination
Parent session restyles `web/` (logo, Mineral landing styles) in branch `feat/brand-logo`
(separate worktree). Keep CSS changes here minimal and additive.

## TDD
- Mode: off (no project config). Runners: `python -m pytest -q`; `npm test`, `npx tsc --noEmit`,
  `npm run build` in `web/`.

## Delivery
- Branch `feat/multi-user-invites`. RDD off. Merge/push to main only with explicit user OK.

## Tasks
- [x] T1 Schema migration + multi-user worker + tests. Route: delegated (2+ non-trivial files). Commits f8173ee (schema), 753e51c (worker).
- [x] T2 Web: Moodle login + invites + /cuenta + /admin + per-user scoping. Route: delegated. Commits fb718e7 (login+scoping), 74e7059 (cuenta+admin). `npm test` 91 passed (12 files); `npx tsc --noEmit` clean; `npm run build` OK (dummy env); smoke via `next start`: /login 200, /, /admin, /moodle and a v1 cookie redirect to /login. Not exercised against live Supabase/Moodle.
- [x] T3 README + VPS/Vercel deployment prompt. Route: inline.

## Progress / Evidence
- T1 done (branch feat/multi-user-invites): `python -m pytest -q`: 113 passed (79 existing + 34 new in
  tests/test_multi_user.py and tests/test_custom_reminders.py); `python -m py_compile *.py scripts/*.py`: OK;
  `python -c "import worker"`: OK. SQL not executed against a live Postgres (reviewed only).
  Worker contract: `fetch_active_users()` raises on failure (empty list = no users); `update_user(id, fields)`;
  reminders select `*,moodle_users(ntfy_topic,active)`; `process_due_reminders` sender is now `send(title, body, topic)`;
  task id = md5(`user_id:url`) via `moodle_api.make_task_id`; local settings keys
  `api_migration_done:<user_id>` and `api_token_alert_fingerprint:<user_id>`; legacy tasks (no user_id) are not
  mirrored to Supabase. Run the SQL migration (and stop the old worker) BEFORE deploying the new worker.

## Next step
- User OK to merge/push to main; then VPS: stop worker, run SQL, pull, restart; Vercel env update + redeploy; first admin login.
