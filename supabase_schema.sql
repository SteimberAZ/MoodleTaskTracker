-- ==========================================================
-- Supabase schema - Moodle Task Tracker
--
-- Run this whole file once in the SQL Editor of the (self-hosted, shared)
-- Supabase database. It is idempotent: running it again is safe.
--
-- All project tables use the "moodle_" prefix because the database is shared
-- with other projects.
--
-- SECURITY MODEL
--   Row Level Security is ENABLED on every table and NO policies are created.
--   The anon / authenticated roles therefore have no access at all; only the
--   service-role key (which bypasses RLS) can read or write these tables.
--   Keep that key server-side only (Vercel server env + VPS .env), never in
--   browser code. moodle_credentials holds the Moodle web-service token, so
--   this matters: with the old permissive policies anyone with the anon key
--   could read it.
-- ==========================================================

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
-- Lock everything down: RLS on, no policies.
-- ==========================================================
ALTER TABLE public.moodle_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_task_milestones  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_custom_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.moodle_credentials      ENABLE ROW LEVEL SECURITY;

-- Remove every policy that may exist on the new tables (for example the old
-- permissive "USING (true)" ones) and on the legacy unprefixed tables, if
-- those still exist. Dropping a policy never touches table data.
DO $$
DECLARE
    pol RECORD;
BEGIN
    -- Legacy permissive policies by their old names (guarded: tables may not exist).
    IF to_regclass('public.settings') IS NOT NULL THEN
        DROP POLICY IF EXISTS "Permitir acceso settings" ON public.settings;
    END IF;
    IF to_regclass('public.tasks') IS NOT NULL THEN
        DROP POLICY IF EXISTS "Permitir acceso tasks" ON public.tasks;
    END IF;
    IF to_regclass('public.task_milestones') IS NOT NULL THEN
        DROP POLICY IF EXISTS "Permitir acceso milestones" ON public.task_milestones;
    END IF;
    IF to_regclass('public.moodle_settings') IS NOT NULL THEN
        DROP POLICY IF EXISTS "Permitir acceso settings" ON public.moodle_settings;
    END IF;
    IF to_regclass('public.moodle_tasks') IS NOT NULL THEN
        DROP POLICY IF EXISTS "Permitir acceso tasks" ON public.moodle_tasks;
    END IF;
    IF to_regclass('public.moodle_task_milestones') IS NOT NULL THEN
        DROP POLICY IF EXISTS "Permitir acceso milestones" ON public.moodle_task_milestones;
    END IF;

    -- Catch-all: any other policy attached to the five project tables.
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
