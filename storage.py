import collections
import contextlib
import os
import sqlite3
import time
from typing import Dict, List, Optional, Tuple
from supabase_client import SupabaseClient


# Settings that must never be mirrored to Supabase.
LOCAL_ONLY_SETTINGS = frozenset({"moodle_session"})

# Upper bound of milestones kept in memory while their task could not be mirrored.
_MAX_DEFERRED_MILESTONES = 1000


class Storage:
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            db_path = os.path.join(base_dir, "moodle_tasks.db")
        self.db_path = db_path
        self._init_db()
        self.supabase = SupabaseClient.for_worker()
        # Supabase mirror bookkeeping. moodle_task_milestones has a FK to moodle_tasks, so a
        # milestone is only mirrored once its task row is known to exist remotely.
        self.last_task_mirror_ok: Optional[bool] = None  # outcome of the latest tasks upsert
        self._unmirrored_tasks: set = set()  # ids of tasks whose last upsert failed
        self._deferred_milestones = collections.deque(maxlen=_MAX_DEFERRED_MILESTONES)

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
                    is_dismissed INTEGER DEFAULT 0,
                    user_id TEXT
                )
            """)

            # Databases created before multi-user mode lack tasks.user_id (legacy rows stay NULL).
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
            if "user_id" not in columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN user_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks (user_id)")

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
        # The Moodle session cookie is a secret: it stays in the local database only.
        if self.supabase.is_configured and key not in LOCAL_ONLY_SETTINGS:
            self.supabase.upsert_setting(key, value)

    def save_tasks(self, tasks: List[Dict], mirror_async: bool = False) -> Tuple[List[Dict], List[Dict]]:
        """
        Inserta o actualiza las tareas recolectadas.
        Retorna: (tareas_nuevas, tareas_actualizadas)

        The Supabase mirror runs inline by default so ``last_task_mirror_ok`` is known (and
        milestones can be ordered after their tasks) when this returns; ``mirror_async=True``
        (UI thread) fires it in the background and leaves the outcome unknown.
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
                            task_url, status, first_seen, last_updated, is_notified, is_dismissed, user_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
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
                        t.get("user_id"),
                    ))
                    new_tasks.append(t)
                else:
                    # 'submitted' is sticky: only an explicit read of the assignment page may
                    # revert it; the calendar-text heuristic never downgrades it.
                    new_status = t.get("status", existing["status"])
                    if (
                        existing["status"] == "submitted"
                        and new_status != "submitted"
                        and t.get("status_source") not in ("assignment_page", "api")
                    ):
                        new_status = "submitted"
                    # Reflect the effective status for the notifier and the Supabase mirror
                    t["status"] = new_status
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
                        new_status,
                        now,
                        task_id,
                    ))
                    updated_tasks.append(t)

            conn.commit()

        if self.supabase.is_configured and tasks:
            self._mirror_tasks(tasks, mirror_async)

        return new_tasks, updated_tasks

    def _mirror_tasks(self, tasks: List[Dict], mirror_async: bool):
        ok = self.supabase.upsert_tasks(tasks, async_call=mirror_async)
        self.last_task_mirror_ok = ok
        ids = {str(t["id"]) for t in tasks}
        if ok is False:
            self._unmirrored_tasks |= ids
            print(f"[Storage] Supabase task mirror FAILED for {len(ids)} tasks; milestones are deferred.")
        elif ok is True:
            self._unmirrored_tasks -= ids
            self._flush_deferred_milestones()

    def _flush_deferred_milestones(self):
        """Mirror milestones that waited for their task row, once that row exists remotely."""
        sent = 0
        for _ in range(len(self._deferred_milestones)):
            task_id, milestone, sent_at = self._deferred_milestones.popleft()
            if task_id in self._unmirrored_tasks:
                self._deferred_milestones.append((task_id, milestone, sent_at))
            else:
                self.supabase.upsert_milestone(task_id, milestone, sent_at)
                sent += 1
        if sent:
            print(f"[Storage] Mirrored {sent} deferred milestones to Supabase.")

    def get_all_tasks(self, order_by_due: bool = True, user_id: Optional[str] = None) -> List[Dict]:
        """Visible tasks; with ``user_id`` only that user's rows, otherwise every row (desktop app)."""
        with self._get_conn() as conn:
            query = "SELECT * FROM tasks WHERE is_dismissed = 0"
            params: tuple = ()
            if user_id is not None:
                query += " AND user_id = ?"
                params = (str(user_id),)
            if order_by_due:
                # Primero las que tienen timestamp válido, orden ascendente (más cercanas primero)
                query += " ORDER BY CASE WHEN due_timestamp > 0 THEN 0 ELSE 1 END, due_timestamp ASC"
            cur = conn.execute(query, params)
            return [dict(row) for row in cur.fetchall()]

    def apply_dismissed(self, user_id: str, muted_ids) -> int:
        """Align the local ``is_dismissed`` flag of one user's tasks with the ids muted on the web.

        Supabase is the source of truth: ids in ``muted_ids`` become 1, every other task of the user
        becomes 0. Returns the number of rows changed.
        """
        muted = {str(i) for i in muted_ids}
        changed = 0
        with self._get_conn() as conn:
            rows = conn.execute("SELECT id, is_dismissed FROM tasks WHERE user_id = ?", (str(user_id),)).fetchall()
            for row in rows:
                want = 1 if row["id"] in muted else 0
                if (row["is_dismissed"] or 0) != want:
                    conn.execute("UPDATE tasks SET is_dismissed = ? WHERE id = ?", (want, row["id"]))
                    changed += 1
            conn.commit()
        return changed

    def mark_notified(self, task_id: str):
        with self._get_conn() as conn:
            conn.execute("UPDATE tasks SET is_notified = 1 WHERE id = ?", (task_id,))
            conn.commit()

    def get_unnotified_new_tasks(self, user_id: Optional[str] = None) -> List[Dict]:
        with self._get_conn() as conn:
            query = "SELECT * FROM tasks WHERE is_notified = 0 AND is_dismissed = 0"
            params: tuple = ()
            if user_id is not None:
                query += " AND user_id = ?"
                params = (str(user_id),)
            cur = conn.execute(query, params)
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
            if task_id in self._unmirrored_tasks:
                # Its task row is missing remotely: the insert would only fail (FK 409).
                if not self._deferred_milestones:
                    print("[Storage] Skipping Supabase milestone mirror: task upsert failed this round.")
                self._deferred_milestones.append((task_id, milestone, now))
            else:
                self.supabase.upsert_milestone(task_id, milestone, now)
