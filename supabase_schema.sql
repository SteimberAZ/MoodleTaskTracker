-- ==========================================================
-- SCHEMA DE SUPABASE - MOODLE TASK TRACKER
-- Copia y pega esto en el SQL Editor de tu proyecto Supabase
-- ==========================================================

-- 1. Tabla de Configuración y Cookies
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabla de Tareas y Entregas Universitarias
CREATE TABLE IF NOT EXISTS public.tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    course TEXT,
    due_date_str TEXT,
    due_timestamp BIGINT,
    task_url TEXT,
    status TEXT DEFAULT 'pending',
    first_seen BIGINT,
    last_updated BIGINT,
    is_notified INTEGER DEFAULT 0,
    is_dismissed INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabla de Hitos de Notificación (Anti-Spam: new, 3d, 2d, 1d, 8h)
CREATE TABLE IF NOT EXISTS public.task_milestones (
    task_id TEXT REFERENCES public.tasks(id) ON DELETE CASCADE,
    milestone TEXT NOT NULL,
    sent_at BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (task_id, milestone)
);

-- Índices de rendimiento
CREATE INDEX IF NOT EXISTS idx_tasks_due ON public.tasks (due_timestamp ASC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON public.tasks (status);

-- Habilitar Row Level Security (RLS) con acceso total para la app
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Permitir acceso settings" ON public.settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Permitir acceso tasks" ON public.tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Permitir acceso milestones" ON public.task_milestones FOR ALL USING (true) WITH CHECK (true);

-- NOTE: the policies above are deliberately permissive (USING (true)); anyone holding the
-- anon key can read/write those tables. Tightening them is out of scope for this change.

-- 4. Custom reminders (created from the web app, delivered by the VPS worker via ntfy)
CREATE TABLE IF NOT EXISTS public.custom_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    message TEXT,
    interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 5),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ NOT NULL,
    next_fire_at TIMESTAMPTZ NOT NULL,
    last_sent_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_custom_reminders_active_next
    ON public.custom_reminders (active, next_fire_at);

-- RLS is enabled with NO policies on purpose: the anon/authenticated roles get no access at all.
-- Only the service-role key (which bypasses RLS) can read/write this table. Keep that key
-- server-side only (Vercel server env + VPS .env), never in browser code.
ALTER TABLE public.custom_reminders ENABLE ROW LEVEL SECURITY;
