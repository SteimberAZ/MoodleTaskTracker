-- ==========================================================
-- Supabase schema - Moodle Task Tracker
--
-- Run this whole file ONCE as an admin (the postgres role) in the SQL editor
-- or with psql. It is idempotent: running it again is safe. It only creates
-- or alters the moodle_* tables and the moodle_app role; no other object of
-- the shared database is touched.
--
-- SECURITY MODEL
--   The database is shared with another production project, so its
--   service_role key must NOT be used here. Instead:
--     * A dedicated NOLOGIN role "moodle_app" can read/write only the
--       moodle_* tables (GRANTs below).
--     * PostgREST connects as "authenticator" and switches to the role named
--       in the request JWT, hence "GRANT moodle_app TO authenticator".
--     * The app sends a long-lived JWT with claim role=moodle_app (see
--       scripts/make_moodle_jwt.py), signed with the instance JWT secret, as
--       "Authorization: Bearer <jwt>", plus the public anon key as "apikey"
--       so the API gateway accepts the request.
--     * RLS is ENABLED on every table. The only policy is "moodle_app_all",
--       for moodle_app. anon/authenticated have no grants and no policies, so
--       the public anon key cannot read moodle_credentials (it holds the
--       Moodle web-service token). service_role bypasses RLS by design.
--
-- CHANGELOG (each section is appended and guarded, so the whole file stays re-runnable)
--   1-5   base tables          6   multi-user mode        7   task details
--   8     Web Push             9   class schedule         10  notification history
--   11    hardening: push/ntfy visibility columns, no-op task update suppression,
--         CHECK constraints, index cleanup, login throttle RPCs, atomic schedule
--         replace. Apply note: run the WHOLE file in the SQL editor (or psql) as
--         postgres, before deploying the worker/web versions that use it; safe to re-run.
-- ==========================================================

-- 0. Dedicated role
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'moodle_app') THEN
        CREATE ROLE moodle_app NOLOGIN NOINHERIT;
    END IF;
END
$$;

-- PostgREST connects as "authenticator" and needs membership to SET ROLE.
GRANT moodle_app TO authenticator;
GRANT USAGE ON SCHEMA public TO moodle_app;

-- 1. Settings (key/value)
CREATE TABLE IF NOT EXISTS public.moodle_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tasks (assignments, quizzes, ...)
CREATE TABLE IF NOT EXISTS public.moodle_tasks (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    course         TEXT,
    due_date_str   TEXT,
    due_timestamp  BIGINT,          -- UNIX seconds
    task_url       TEXT,
    status         TEXT DEFAULT 'pending',
    first_seen     BIGINT,
    last_updated   BIGINT,
    is_notified    INTEGER DEFAULT 0,
    is_dismissed   INTEGER DEFAULT 0,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Optional Moodle identifiers filled by the web-service sync.
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS assign_id INTEGER;
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS course_module_id INTEGER;

-- 3. Notification milestones (anti-spam: new, 3d, 2d, 1d, 8h)
CREATE TABLE IF NOT EXISTS public.moodle_task_milestones (
    task_id    TEXT NOT NULL REFERENCES public.moodle_tasks(id) ON DELETE CASCADE,
    milestone  TEXT NOT NULL,
    sent_at    BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (task_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_moodle_tasks_due    ON public.moodle_tasks (due_timestamp ASC);
-- idx_moodle_tasks_status was dropped in section 11 (every task query filters by user_id first).

-- 4. Custom reminders (created from the web app, delivered by the VPS worker via ntfy)
CREATE TABLE IF NOT EXISTS public.moodle_custom_reminders (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title            TEXT NOT NULL,
    message          TEXT,
    interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 5),
    starts_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at          TIMESTAMPTZ NOT NULL,
    next_fire_at     TIMESTAMPTZ NOT NULL,
    last_sent_at     TIMESTAMPTZ,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    task_id          TEXT NULL REFERENCES public.moodle_tasks(id) ON DELETE SET NULL,
    CHECK (ends_at > starts_at)
);

-- If the table already existed without the link, add it.
ALTER TABLE public.moodle_custom_reminders
    ADD COLUMN IF NOT EXISTS task_id TEXT NULL REFERENCES public.moodle_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_moodle_custom_reminders_active_next
    ON public.moodle_custom_reminders (active, next_fire_at);

-- 5. Moodle credentials: a single row holding the mobile web-service token.
--    The password is NEVER stored; the web server exchanges it for a token
--    through login/token.php and discards it.
CREATE TABLE IF NOT EXISTS public.moodle_credentials (
    id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    moodle_url    TEXT NOT NULL,
    username      TEXT NOT NULL,
    token         TEXT NOT NULL,
    site_userid   INTEGER,
    fullname      TEXT,
    connected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error    TEXT,
    last_error_at TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================================
-- Privileges + RLS: moodle_app only.
-- (No sequences are used: primary keys are TEXT, UUID or constant.)
-- ==========================================================
ALTER TABLE public.moodle_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_task_milestones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_custom_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_credentials      ENABLE ROW LEVEL SECURITY;

-- Supabase default privileges grant new public tables to anon/authenticated.
REVOKE ALL ON public.moodle_settings         FROM anon, authenticated;
REVOKE ALL ON public.moodle_tasks            FROM anon, authenticated;
REVOKE ALL ON public.moodle_task_milestones  FROM anon, authenticated;
REVOKE ALL ON public.moodle_custom_reminders FROM anon, authenticated;
REVOKE ALL ON public.moodle_credentials      FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_settings         TO moodle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_tasks            TO moodle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_task_milestones  TO moodle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_custom_reminders TO moodle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_credentials      TO moodle_app;

-- Replace any older policy on the project tables (for example the old permissive
-- "USING (true)" ones for anon) with a single policy for moodle_app.
-- Dropping a policy never touches table data.
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN (
              'moodle_settings', 'moodle_tasks', 'moodle_task_milestones',
              'moodle_custom_reminders', 'moodle_credentials'
          )
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    END LOOP;
END
$$;

CREATE POLICY moodle_app_all ON public.moodle_settings
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);
CREATE POLICY moodle_app_all ON public.moodle_tasks
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);
CREATE POLICY moodle_app_all ON public.moodle_task_milestones
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);
CREATE POLICY moodle_app_all ON public.moodle_custom_reminders
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);
CREATE POLICY moodle_app_all ON public.moodle_credentials
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);

-- ==========================================================
-- 6. Multi-user mode (invite-only)
--
-- Idempotent and safe to re-run in the shared database: it only creates or
-- alters moodle_* objects. Each person logs in with their Moodle account
-- (a row in moodle_users, holding that user's own web-service token and a
-- private ntfy topic); moodle_invites holds the single-use invite codes.
--
-- WARNING (one-time data change): moodle_tasks rows that have no owner are
-- deleted when user_id becomes mandatory. They are derived data and the
-- worker re-syncs them per user. Stop the old single-user worker before
-- running this migration, otherwise its user_id-less upserts will be rejected.
-- ==========================================================
CREATE TABLE IF NOT EXISTS public.moodle_users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    moodle_url    TEXT NOT NULL,
    site_userid   INTEGER NOT NULL,
    username      TEXT NOT NULL,
    fullname      TEXT,
    token         TEXT,
    ntfy_topic    TEXT NOT NULL UNIQUE,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    last_error    TEXT,
    last_error_at TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (moodle_url, site_userid)
);

CREATE TABLE IF NOT EXISTS public.moodle_invites (
    code       TEXT PRIMARY KEY,
    created_by UUID REFERENCES public.moodle_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    used_at    TIMESTAMPTZ,
    used_by    UUID REFERENCES public.moodle_users(id) ON DELETE SET NULL
);

-- Tasks belong to a user. The column is added first without a constraint so a
-- partially applied earlier run is repaired by the guarded steps below.
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS user_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_tasks_user_id_fkey'
          AND conrelid = 'public.moodle_tasks'::regclass
    ) THEN
        ALTER TABLE public.moodle_tasks
            ADD CONSTRAINT moodle_tasks_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.moodle_users(id) ON DELETE CASCADE;
    END IF;
END
$$;

-- Ownerless tasks (created before multi-user mode) are derived data: drop them
-- together with their milestones; the worker re-creates them for each user.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.moodle_tasks WHERE user_id IS NULL) THEN
        DELETE FROM public.moodle_task_milestones
        WHERE task_id IN (SELECT id FROM public.moodle_tasks WHERE user_id IS NULL);
        DELETE FROM public.moodle_tasks WHERE user_id IS NULL;
    END IF;
END
$$;

ALTER TABLE public.moodle_tasks ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_moodle_tasks_user_due
    ON public.moodle_tasks (user_id, due_timestamp);

-- Custom reminders: owner is nullable (reminders created before multi-user
-- mode stay orphaned until the admin claims them; the worker skips them).
ALTER TABLE public.moodle_custom_reminders ADD COLUMN IF NOT EXISTS user_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_custom_reminders_user_id_fkey'
          AND conrelid = 'public.moodle_custom_reminders'::regclass
    ) THEN
        ALTER TABLE public.moodle_custom_reminders
            ADD CONSTRAINT moodle_custom_reminders_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.moodle_users(id) ON DELETE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_moodle_custom_reminders_user
    ON public.moodle_custom_reminders (user_id);

-- The single-row credentials table is superseded by moodle_users.token.
COMMENT ON TABLE public.moodle_credentials IS
    'DEPRECATED: superseded by moodle_users (one token per user). Kept only for rollback.';

-- Privileges + RLS for the new tables (same model as above).
ALTER TABLE public.moodle_users   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_invites ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.moodle_users   FROM anon, authenticated;
REVOKE ALL ON public.moodle_invites FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_users   TO moodle_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_invites TO moodle_app;

DROP POLICY IF EXISTS moodle_app_all ON public.moodle_users;
CREATE POLICY moodle_app_all ON public.moodle_users
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS moodle_app_all ON public.moodle_invites;
CREATE POLICY moodle_app_all ON public.moodle_invites
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);

-- ==========================================================
-- 7. Task details (UX pass): description, course, module, teachers.
--    Filled by the worker's API sync; existing grants/RLS cover new columns.
--    teachers is a JSON array of full names, e.g. ["Ana Perez", "Luis Mora"].
--    is_dismissed ("muted from the web") is never written by the worker.
-- ==========================================================
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS course_id integer;
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS module text;
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS teachers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS details_updated_at timestamptz;

-- Set by the web when a user confirms the test notification arrived (the worker never reads it).
ALTER TABLE public.moodle_users ADD COLUMN IF NOT EXISTS notify_confirmed_at timestamptz;

-- ==========================================================
-- 8. Native Web Push (installed PWA) with ntfy as an optional channel.
--    The web stores each browser's push subscription here; only the worker, which alone holds the
--    VAPID private key, sends pushes. "Enviar prueba" sets test_requested_at and the worker answers
--    it. Health columns belong to the worker: a successful send resets failure_count, HTTP 404/410
--    deletes the row and so does the 10th consecutive failure.
--    moodle_users.ntfy_enabled lets a user switch the ntfy copy of every notification off.
-- ==========================================================
CREATE TABLE IF NOT EXISTS public.moodle_push_subscriptions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES public.moodle_users(id) ON DELETE CASCADE,
    endpoint          text NOT NULL UNIQUE,
    p256dh            text NOT NULL,
    auth              text NOT NULL,
    user_agent        text,
    platform          text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    last_success_at   timestamptz,
    last_failure_at   timestamptz,
    failure_count     integer NOT NULL DEFAULT 0,
    test_requested_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_moodle_push_subscriptions_user
    ON public.moodle_push_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_moodle_push_subscriptions_test
    ON public.moodle_push_subscriptions (test_requested_at)
    WHERE test_requested_at IS NOT NULL;

-- Existing users keep ntfy on when this column is added (ntfy was their only channel before Web
-- Push). DEFAULT true only fills the rows that exist at that moment; section 11.1 then sets the
-- default to false, so users created afterwards start with the ntfy copy off.
ALTER TABLE public.moodle_users ADD COLUMN IF NOT EXISTS ntfy_enabled boolean NOT NULL DEFAULT true;

-- Privileges + RLS (same model as above): moodle_app only.
ALTER TABLE public.moodle_push_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.moodle_push_subscriptions FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_push_subscriptions TO moodle_app;

DROP POLICY IF EXISTS moodle_app_all ON public.moodle_push_subscriptions;
CREATE POLICY moodle_app_all ON public.moodle_push_subscriptions
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);

-- ==========================================================
-- 9. Class schedule import (SGA "Horario de clases" PDF) + class reminders.
--    The web parses the PDF, the user confirms the preview and the classes land here (a re-import
--    replaces the user's rows). Only class rows are stored: never the PDF, cedula or student name.
--    weekday is ISO (1 = lunes ... 7 = domingo); times are wall-clock Ecuador (UTC-5).
--    moodle_users.class_reminder_minutes is the single lead time of the worker's reminder:
--    30, 60 or 180 minutes before each class; NULL = reminders off.
-- ==========================================================
CREATE TABLE IF NOT EXISTS public.moodle_class_schedule (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES public.moodle_users(id) ON DELETE CASCADE,
    subject      text NOT NULL,
    level        integer,
    parallel     text,
    credits      integer,
    teacher      text,
    department   text,
    weekday      smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_time   time NOT NULL,
    end_time     time NOT NULL,
    place        text,
    room_code    text,
    room_type    text,
    floor        text,
    period_label text,
    period_end   date,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_moodle_class_schedule_user_weekday
    ON public.moodle_class_schedule (user_id, weekday);

ALTER TABLE public.moodle_users ADD COLUMN IF NOT EXISTS class_reminder_minutes integer;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_users_class_reminder_minutes_check'
          AND conrelid = 'public.moodle_users'::regclass
    ) THEN
        ALTER TABLE public.moodle_users
            ADD CONSTRAINT moodle_users_class_reminder_minutes_check
            CHECK (class_reminder_minutes IN (30, 60, 180));
    END IF;
END
$$;

-- Privileges + RLS (same model as above): moodle_app only.
ALTER TABLE public.moodle_class_schedule ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.moodle_class_schedule FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_class_schedule TO moodle_app;

DROP POLICY IF EXISTS moodle_app_all ON public.moodle_class_schedule;
CREATE POLICY moodle_app_all ON public.moodle_class_schedule
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);

-- ==========================================================
-- 10. Notification history ("Avisos" > Historial).
--     The worker writes one row per notification it executes for a user (not per device): the
--     kind, the text, the per-channel outcome and the overall status. The web only reads it and
--     lets a user clear their own rows. Rows older than 90 days are pruned by the worker once a day.
--     kind:   task | reminder | class | status | test
--     status: sent (at least one channel accepted it) | failed
--     push_ok / push_total: Web Push devices that accepted / devices tried (push_total -1: the
--     user's devices could not be read, so push failed without trying any).
--     ntfy_attempted / ntfy_ok: whether the ntfy copy was tried and whether it was accepted.
-- ==========================================================
CREATE TABLE IF NOT EXISTS public.moodle_notification_log (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES public.moodle_users(id) ON DELETE CASCADE,
    kind           text NOT NULL CHECK (kind IN ('task', 'reminder', 'class', 'status', 'test')),
    title          text NOT NULL,
    body           text,
    url            text,
    tag            text,
    status         text NOT NULL CHECK (status IN ('sent', 'failed')),
    push_ok        integer NOT NULL DEFAULT 0,
    push_total     integer NOT NULL DEFAULT 0,
    ntfy_attempted boolean NOT NULL DEFAULT false,
    ntfy_ok        boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moodle_notification_log_user_created
    ON public.moodle_notification_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moodle_notification_log_created
    ON public.moodle_notification_log (created_at);

-- Privileges + RLS (same model as above): moodle_app only.
ALTER TABLE public.moodle_notification_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.moodle_notification_log FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_notification_log TO moodle_app;

DROP POLICY IF EXISTS moodle_app_all ON public.moodle_notification_log;
CREATE POLICY moodle_app_all ON public.moodle_notification_log
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);

-- ==========================================================
-- 11. Hardening: push/ntfy visibility, write amplification, constraints, login throttle.
--     Every statement is guarded (IF NOT EXISTS / CREATE OR REPLACE / DO blocks that read the
--     catalogs) and touches only public.moodle_* objects plus the built-in
--     suppress_redundant_updates_trigger(). Until the worker and the web start using the new
--     columns and functions, behavior is unchanged (except the ntfy_enabled default for NEW users).
--
--     moodle_settings keys (no DDL: key/value rows; moodle_app already has SELECT/INSERT/UPDATE/
--     DELETE on the table, granted in the privileges block above, and the web reads it):
--       'worker_status'    JSON string, the worker heartbeat written every tick:
--                          {at, version, webpush_enabled, push_status, last_push_ok_at,
--                           push_counts, users_ok, users_err, last_round_mode, tick_seconds,
--                           sync_seconds, delivery_lag_seconds}
--       'vapid_public_key' base64url VAPID public key the worker loaded, written at worker startup
--                          (the web compares it with NEXT_PUBLIC_VAPID_PUBLIC_KEY).
-- ==========================================================

-- 11.1 moodle_users
-- ntfy_confirmed_at: set when the user proves they receive ntfy (confirmed on /cuenta). The worker
-- counts an ntfy copy as "delivered" only when it is set, so ntfy can no longer mask push failures.
ALTER TABLE public.moodle_users ADD COLUMN IF NOT EXISTS ntfy_confirmed_at timestamptz;
-- last_synced_at: written by the worker after a successful per-user Moodle sync.
ALTER TABLE public.moodle_users ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
-- New users start with the ntfy copy off (Web Push is the primary channel). Existing rows keep
-- their current value.
ALTER TABLE public.moodle_users ALTER COLUMN ntfy_enabled SET DEFAULT false;
-- Owner decision: admins who already use ntfy are treated as confirmed. Nobody else is backfilled.
-- Only rows still NULL are touched, so re-running it never moves an existing confirmation.
UPDATE public.moodle_users
SET ntfy_confirmed_at = now()
WHERE is_admin AND ntfy_enabled AND ntfy_confirmed_at IS NULL;

-- 11.2 moodle_push_subscriptions: why the last delivery to this device failed (the worker caps it
-- at 120 characters; the CHECK leaves headroom).
ALTER TABLE public.moodle_push_subscriptions ADD COLUMN IF NOT EXISTS last_failure_reason text;

-- 11.3 moodle_notification_log: the Web Push outcome of a history row, so a delivery that only
-- reached ntfy no longer looks like a healthy push.
--   ok         every device accepted it        partial    some devices accepted it
--   failed     no device accepted it           no_devices the user has no subscription
--   read_error the devices could not be read   disabled   the worker's Web Push sender is off
--   NULL       rows written before this column existed (or by an older worker)
-- The status CHECK ('sent', 'failed') is unchanged.
ALTER TABLE public.moodle_notification_log ADD COLUMN IF NOT EXISTS push_state text;

-- 11.4 moodle_tasks
-- missing_since: set by the worker when a task stops coming back from Moodle (deleted or hidden
-- activity); the worker sends it as null again when the task reappears.
ALTER TABLE public.moodle_tasks ADD COLUMN IF NOT EXISTS missing_since timestamptz;

-- The worker stops sending first_seen: new rows get the insert time (UNIX seconds, like the other
-- BIGINT stamps of this table) and existing rows keep theirs.
ALTER TABLE public.moodle_tasks ALTER COLUMN first_seen SET DEFAULT (extract(epoch FROM now()))::bigint;

-- The worker upserts every fetched task each round and stamps details_updated_at with the fetch
-- time. Keep the previous stamp when the details themselves did not change, so an unchanged row is
-- byte-identical and moodle_tasks_z_skip_noop drops the update (no new tuple, no WAL, no bloat).
CREATE OR REPLACE FUNCTION public.moodle_tasks_keep_details_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    IF OLD.details_updated_at IS NOT NULL
       AND NEW.description IS NOT DISTINCT FROM OLD.description
       AND NEW.teachers IS NOT DISTINCT FROM OLD.teachers THEN
        NEW.details_updated_at := OLD.details_updated_at;
    END IF;
    RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.moodle_tasks_keep_details_stamp() FROM PUBLIC, anon, authenticated;

-- Row triggers of the same event fire in name order: "a_" runs before "z_", so the stamp is
-- restored before the redundancy check compares the old and new rows.
DROP TRIGGER IF EXISTS moodle_tasks_a_keep_details_stamp ON public.moodle_tasks;
CREATE TRIGGER moodle_tasks_a_keep_details_stamp
    BEFORE UPDATE ON public.moodle_tasks
    FOR EACH ROW EXECUTE FUNCTION public.moodle_tasks_keep_details_stamp();

-- Scoped with "OF title" so it only fires for the worker's upserts (their SET list always holds
-- title, NOT NULL). The web's mute PATCH sets only is_dismissed with return=representation: a
-- suppressed update returns no row, so re-muting an already muted task would look like "not found".
DROP TRIGGER IF EXISTS moodle_tasks_z_skip_noop ON public.moodle_tasks;
CREATE TRIGGER moodle_tasks_z_skip_noop
    BEFORE UPDATE OF title ON public.moodle_tasks
    FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

-- 11.5 Indexes
-- Every task query filters by user_id first (idx_moodle_tasks_user_due), so the low-cardinality
-- status index is pure write cost. To confirm it is unused before applying, run:
--   SELECT indexrelname, idx_scan FROM pg_stat_user_indexes
--   WHERE relname = 'moodle_tasks' ORDER BY indexrelname;
DROP INDEX IF EXISTS public.idx_moodle_tasks_status;
-- idx_moodle_tasks_due is kept.

-- Reminders linked to a task: ON DELETE SET NULL and the per-task lookups scan by task_id.
CREATE INDEX IF NOT EXISTS idx_moodle_custom_reminders_task
    ON public.moodle_custom_reminders (task_id)
    WHERE task_id IS NOT NULL;

-- 11.6 CHECK constraints
-- Each one is added NOT VALID (new and updated rows are checked right away) and then validated.
-- If existing rows violate it, the validation is skipped with a WARNING instead of aborting the
-- file: fix the rows the SELECT above it finds and re-run the file to validate it.

-- Violating rows: SELECT id, status FROM public.moodle_tasks WHERE status NOT IN ('pending', 'submitted');
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_tasks_status_check'
          AND conrelid = 'public.moodle_tasks'::regclass
    ) THEN
        ALTER TABLE public.moodle_tasks
            ADD CONSTRAINT moodle_tasks_status_check
            CHECK (status IN ('pending', 'submitted')) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_tasks VALIDATE CONSTRAINT moodle_tasks_status_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_tasks_status_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- is_dismissed is an INTEGER flag (0 = visible, 1 = muted from the web).
-- Violating rows: SELECT id, is_dismissed FROM public.moodle_tasks WHERE is_dismissed NOT IN (0, 1);
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_tasks_is_dismissed_check'
          AND conrelid = 'public.moodle_tasks'::regclass
    ) THEN
        ALTER TABLE public.moodle_tasks
            ADD CONSTRAINT moodle_tasks_is_dismissed_check
            CHECK (is_dismissed IN (0, 1)) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_tasks VALIDATE CONSTRAINT moodle_tasks_is_dismissed_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_tasks_is_dismissed_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- Violating rows: SELECT task_id, milestone FROM public.moodle_task_milestones
--   WHERE milestone NOT IN ('new', '3d', '2d', '1d', '8h');
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_task_milestones_milestone_check'
          AND conrelid = 'public.moodle_task_milestones'::regclass
    ) THEN
        ALTER TABLE public.moodle_task_milestones
            ADD CONSTRAINT moodle_task_milestones_milestone_check
            CHECK (milestone IN ('new', '3d', '2d', '1d', '8h')) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_task_milestones VALIDATE CONSTRAINT moodle_task_milestones_milestone_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_task_milestones_milestone_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- Violating rows: SELECT id, failure_count FROM public.moodle_push_subscriptions WHERE failure_count < 0;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_push_subscriptions_failure_count_check'
          AND conrelid = 'public.moodle_push_subscriptions'::regclass
    ) THEN
        ALTER TABLE public.moodle_push_subscriptions
            ADD CONSTRAINT moodle_push_subscriptions_failure_count_check
            CHECK (failure_count >= 0) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_push_subscriptions VALIDATE CONSTRAINT moodle_push_subscriptions_failure_count_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_push_subscriptions_failure_count_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- Violating rows: SELECT id, char_length(last_failure_reason) FROM public.moodle_push_subscriptions
--   WHERE char_length(last_failure_reason) > 200;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_push_subscriptions_last_failure_reason_check'
          AND conrelid = 'public.moodle_push_subscriptions'::regclass
    ) THEN
        ALTER TABLE public.moodle_push_subscriptions
            ADD CONSTRAINT moodle_push_subscriptions_last_failure_reason_check
            CHECK (char_length(last_failure_reason) <= 200) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_push_subscriptions VALIDATE CONSTRAINT moodle_push_subscriptions_last_failure_reason_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_push_subscriptions_last_failure_reason_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- push_total -1 is valid: the user's devices could not be read (see section 10), with push_ok 0.
-- Violating rows: SELECT id, push_ok, push_total FROM public.moodle_notification_log
--   WHERE NOT (push_total >= -1 AND push_ok >= 0 AND push_ok <= greatest(push_total, 0));
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_notification_log_push_counts_check'
          AND conrelid = 'public.moodle_notification_log'::regclass
    ) THEN
        ALTER TABLE public.moodle_notification_log
            ADD CONSTRAINT moodle_notification_log_push_counts_check
            CHECK (push_total >= -1 AND push_ok >= 0 AND push_ok <= greatest(push_total, 0)) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_notification_log VALIDATE CONSTRAINT moodle_notification_log_push_counts_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_notification_log_push_counts_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- Violating rows: SELECT id, push_state FROM public.moodle_notification_log WHERE push_state NOT IN
--   ('ok', 'partial', 'failed', 'no_devices', 'read_error', 'disabled');
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moodle_notification_log_push_state_check'
          AND conrelid = 'public.moodle_notification_log'::regclass
    ) THEN
        ALTER TABLE public.moodle_notification_log
            ADD CONSTRAINT moodle_notification_log_push_state_check
            CHECK (push_state IS NULL OR push_state IN ('ok', 'partial', 'failed', 'no_devices', 'read_error', 'disabled')) NOT VALID;
    END IF;
    BEGIN
        ALTER TABLE public.moodle_notification_log VALIDATE CONSTRAINT moodle_notification_log_push_state_check;
    EXCEPTION WHEN check_violation THEN
        RAISE WARNING 'moodle_notification_log_push_state_check stays NOT VALID: existing rows violate it';
    END;
END
$$;

-- 11.7 Login throttle.
-- The web keys each login attempt by a hash (never the raw username or IP) and asks
-- moodle_login_gate() first: it returns the seconds the key is still blocked (0 = allowed).
-- moodle_login_result() then records the outcome: success clears the key; the 5th failure inside
-- a 15-minute window blocks it for 15 minutes. Rows idle for more than a day are pruned on the fly.
CREATE TABLE IF NOT EXISTS public.moodle_login_failures (
    key_hash      text PRIMARY KEY,
    failures      integer NOT NULL DEFAULT 0,
    window_start  timestamptz NOT NULL DEFAULT now(),
    blocked_until timestamptz
);

ALTER TABLE public.moodle_login_failures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.moodle_login_failures FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_login_failures TO moodle_app;

DROP POLICY IF EXISTS moodle_app_all ON public.moodle_login_failures;
CREATE POLICY moodle_app_all ON public.moodle_login_failures
    FOR ALL TO moodle_app USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.moodle_login_gate(p_key_hash text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT greatest(0, ceil(extract(epoch FROM (f.blocked_until - now()))))::integer
         FROM public.moodle_login_failures f
         WHERE f.key_hash = p_key_hash),
        0
    );
$$;

CREATE OR REPLACE FUNCTION public.moodle_login_result(p_key_hash text, p_success boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    IF p_key_hash IS NULL OR p_key_hash = '' THEN
        RETURN;
    END IF;

    -- Opportunistic cleanup of stale keys (a block lasts 15 minutes, far less than a day).
    DELETE FROM public.moodle_login_failures
    WHERE window_start < now() - interval '1 day';

    IF p_success THEN
        DELETE FROM public.moodle_login_failures WHERE key_hash = p_key_hash;
        RETURN;
    END IF;

    INSERT INTO public.moodle_login_failures AS f (key_hash, failures, window_start, blocked_until)
    VALUES (p_key_hash, 1, now(), NULL)
    ON CONFLICT (key_hash) DO UPDATE SET
        failures = CASE
            WHEN f.window_start < now() - interval '15 minutes' THEN 1
            ELSE f.failures + 1
        END,
        window_start = CASE
            WHEN f.window_start < now() - interval '15 minutes' THEN now()
            ELSE f.window_start
        END,
        blocked_until = CASE
            WHEN f.window_start >= now() - interval '15 minutes' AND f.failures + 1 >= 5
                THEN now() + interval '15 minutes'
            ELSE f.blocked_until
        END;
END
$$;

REVOKE EXECUTE ON FUNCTION public.moodle_login_gate(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.moodle_login_result(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moodle_login_gate(text) TO moodle_app;
GRANT EXECUTE ON FUNCTION public.moodle_login_result(text, boolean) TO moodle_app;

-- 11.8 Atomic class schedule replace (optional RPC; the web falls back to insert-then-delete when
-- it is missing). Deletes the user's rows and inserts the new ones in one transaction, so a reader
-- never sees an empty or doubled schedule. Each element of p_rows carries the columns below; a
-- user_id inside the rows is ignored (p_user_id wins), id and created_at take their defaults.
CREATE OR REPLACE FUNCTION public.moodle_replace_class_schedule(p_user_id uuid, p_rows jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22004';
    END IF;
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'p_rows must be a JSON array' USING ERRCODE = '22023';
    END IF;

    -- Two overlapping calls for one user (two tabs, a retried request) run one after the other:
    -- under READ COMMITTED the second DELETE would not see the first call's inserted rows and the
    -- user would end up with every class twice.
    PERFORM pg_advisory_xact_lock(hashtextextended('moodle_replace_class_schedule:' || p_user_id::text, 0));

    DELETE FROM public.moodle_class_schedule WHERE user_id = p_user_id;

    INSERT INTO public.moodle_class_schedule (
        user_id, subject, level, parallel, credits, teacher, department, weekday,
        start_time, end_time, place, room_code, room_type, floor, period_label, period_end
    )
    SELECT
        p_user_id, r.subject, r.level, r.parallel, r.credits, r.teacher, r.department, r.weekday,
        r.start_time, r.end_time, r.place, r.room_code, r.room_type, r.floor, r.period_label, r.period_end
    FROM jsonb_to_recordset(p_rows) AS r(
        subject      text,
        level        integer,
        parallel     text,
        credits      integer,
        teacher      text,
        department   text,
        weekday      smallint,
        start_time   time,
        end_time     time,
        place        text,
        room_code    text,
        room_type    text,
        floor        text,
        period_label text,
        period_end   date
    );
END
$$;

REVOKE EXECUTE ON FUNCTION public.moodle_replace_class_schedule(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moodle_replace_class_schedule(uuid, jsonb) TO moodle_app;

-- Ask PostgREST to reload its schema cache so the new tables and columns are served right away.
NOTIFY pgrst, 'reload schema';
