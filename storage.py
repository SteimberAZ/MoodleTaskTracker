import contextlib
import os
import sqlite3
import time
from typing import Dict, List, Optional, Tuple
from supabase_client import SupabaseClient


class Storage:
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            db_path = os.path.join(base_dir, "moodle_tasks.db")
        self.db_path = db_path
        self._init_db()
        self.supabase = SupabaseClient()

    @contextlib.contextmanager
    def _get_conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self):
        with self._get_conn() as conn:
            # Tabla de configuración
            conn.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                )
            """)

            # Tabla de tareas
            conn.execute("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    course TEXT,
                    due_date_str TEXT,
                    due_timestamp INTEGER,
                    task_url TEXT,
                    status TEXT DEFAULT 'pending',
                    first_seen INTEGER,
                    last_updated INTEGER,
                    is_notified INTEGER DEFAULT 0,
                    is_dismissed INTEGER DEFAULT 0
                )
            """)

            # Tabla de hitos de recordatorio (nueva, 3d, 2d, 1d, 8h)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS task_milestones (
                    task_id TEXT,
                    milestone TEXT,
                    sent_at INTEGER,
                    PRIMARY KEY (task_id, milestone)
                )
            """)

            # Ajustes por defecto si no existen
            defaults = {
                "moodle_url": "https://evirtual.utm.edu.ec",
                "moodle_session": "",
                "check_interval_mins": "30",
                "auto_notify": "1",
                "last_checked": "Nunca",
            }
            for k, v in defaults.items():
                conn.execute(
                    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                    (k, v),
                )
            conn.commit()

    def get_setting(self, key: str, default: Optional[str] = None) -> Optional[str]:
        with self._get_conn() as conn:
            cur = conn.execute("SELECT value FROM settings WHERE key = ?", (key,))
            row = cur.fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str):
        with self._get_conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, str(value)),
            )
            conn.commit()
        if self.supabase.is_configured:
            self.supabase.upsert_setting(key, value)

    def save_tasks(self, tasks: List[Dict]) -> Tuple[List[Dict], List[Dict]]:
        """
        Inserta o actualiza las tareas recolectadas.
        Retorna: (tareas_nuevas, tareas_actualizadas)
        """
        new_tasks = []
        updated_tasks = []
        now = int(time.time())

        with self._get_conn() as conn:
            for t in tasks:
                task_id = t["id"]
                cur = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
                existing = cur.fetchone()

                if existing is None:
                    # Nueva tarea detectada
                    conn.execute("""
                        INSERT INTO tasks (
                            id, title, course, due_date_str, due_timestamp,
                            task_url, status, first_seen, last_updated, is_notified, is_dismissed
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                    """, (
                        task_id,
                        t["title"],
                        t.get("course", "Sin materia especificada"),
                        t.get("due_date_str", ""),
                        t.get("due_timestamp", 0),
                        t.get("task_url", ""),
                        t.get("status", "pending"),
                        now,
                        now,
                    ))
                    new_tasks.append(t)
                else:
                    # Actualizar campos
                    conn.execute("""
                        UPDATE tasks SET
                            title = ?,
                            course = ?,
                            due_date_str = ?,
                            due_timestamp = ?,
                            task_url = ?,
                            status = ?,
                            last_updated = ?
                        WHERE id = ?
                    """, (
                        t["title"],
                        t.get("course", existing["course"]),
                        t.get("due_date_str", existing["due_date_str"]),
                        t.get("due_timestamp", existing["due_timestamp"]),
                        t.get("task_url", existing["task_url"]),
                        t.get("status", existing["status"]),
                        now,
                        task_id,
                    ))
                    updated_tasks.append(t)

            conn.commit()

        if self.supabase.is_configured and tasks:
            self.supabase.upsert_tasks(tasks)

        return new_tasks, updated_tasks

    def get_all_tasks(self, order_by_due: bool = True) -> List[Dict]:
        with self._get_conn() as conn:
            query = "SELECT * FROM tasks WHERE is_dismissed = 0"
            if order_by_due:
                # Primero las que tienen timestamp válido, orden ascendente (más cercanas primero)
                query += " ORDER BY CASE WHEN due_timestamp > 0 THEN 0 ELSE 1 END, due_timestamp ASC"
            cur = conn.execute(query)
            return [dict(row) for row in cur.fetchall()]

    def mark_notified(self, task_id: str):
        with self._get_conn() as conn:
            conn.execute("UPDATE tasks SET is_notified = 1 WHERE id = ?", (task_id,))
            conn.commit()

    def get_unnotified_new_tasks(self) -> List[Dict]:
        with self._get_conn() as conn:
            cur = conn.execute("SELECT * FROM tasks WHERE is_notified = 0 AND is_dismissed = 0")
            return [dict(row) for row in cur.fetchall()]

    def has_notified_milestone(self, task_id: str, milestone: str) -> bool:
        """Verifica si ya se envió el recordatorio para un hito específico de la tarea."""
        with self._get_conn() as conn:
            cur = conn.execute(
                "SELECT 1 FROM task_milestones WHERE task_id = ? AND milestone = ?",
                (task_id, milestone),
            )
            return cur.fetchone() is not None

    def record_milestone(self, task_id: str, milestone: str):
        """Registra que un hito ya fue notificado para no repetir spam."""
        now = int(time.time())
        with self._get_conn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO task_milestones (task_id, milestone, sent_at) VALUES (?, ?, ?)",
                (task_id, milestone, now),
            )
            conn.commit()
        if self.supabase.is_configured:
            self.supabase.upsert_milestone(task_id, milestone, now)
