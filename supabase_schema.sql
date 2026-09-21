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
