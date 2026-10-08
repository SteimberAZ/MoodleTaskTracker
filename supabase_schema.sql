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
CREATE INDEX IF NOT EXISTS idx_moodle_tasks_status ON public.moodle_tasks (status);

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

-- Ask PostgREST to reload its schema cache so the new tables and columns are served right away.
NOTIFY pgrst, 'reload schema';
