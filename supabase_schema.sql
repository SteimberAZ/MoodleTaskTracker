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
--     * A dedicated NOLOGIN role "moodle_app" can read/write only the five
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
