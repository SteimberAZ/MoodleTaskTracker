import collections
import contextlib
import json
import os
import sqlite3
import time
from typing import Dict, Iterable, List, Optional, Set, Tuple
from supabase_client import SupabaseClient


# Settings that must never be mirrored to Supabase (the cookie is a secret; the prune and mirror
# times are per worker).
LOCAL_ONLY_SETTINGS = frozenset({"moodle_session", "notification_log_pruned_at", "last_full_task_mirror_at"})

# Key prefixes of per-user settings that stay local too ("last_full_task_mirror_at:<user id>").
LOCAL_ONLY_PREFIXES = ("last_full_task_mirror_at:",)

# Upper bound of milestones kept in memory while their task could not be mirrored.
_MAX_DEFERRED_MILESTONES = 1000

# Every task is re-sent to Supabase at least this often, even when nothing changed locally.
FULL_TASK_MIRROR_EVERY = 24 * 3600

# Time milestones and the seconds before the deadline at which they fire (see notifier.py).
MILESTONE_THRESHOLDS: Tuple[Tuple[str, int], ...] = (
    ("8h", 8 * 3600),
    ("1d", 24 * 3600),
    ("2d", 48 * 3600),
    ("3d", 72 * 3600),
)

# Hydration after a lost SQLite file: milestones of this many days, and the per-user flags that keep
# the first-sync guard and the token alert from firing again.
HYDRATE_DAYS = 14
HYDRATED_SETTING_PREFIXES = ("api_migration_done", "api_token_alert_fingerprint")

# Fields of a task that reach the moodle_tasks mirror (details_updated_at aside): a task whose
# values are unchanged is not sent again.
_MIRRORED_FIELDS = (
    "title", "course", "due_date_str", "due_timestamp", "task_url", "status", "module", "course_id",
    "description", "teachers", "assign_id", "course_module_id", "user_id",
)


def is_local_only_setting(key: str) -> bool:
    return key in LOCAL_ONLY_SETTINGS or any(str(key).startswith(p) for p in LOCAL_ONLY_PREFIXES)


def _signature(values) -> str:
    return json.dumps(values, sort_keys=True, ensure_ascii=False, default=str)


def mirror_signature(t: Dict) -> str:
    """Fingerprint of the mirrored values of a task (``details_updated_at`` excluded)."""
    return _signature({k: t.get(k) for k in _MIRRORED_FIELDS})


def details_signature(t: Dict) -> str:
    """Fingerprint of the task details (description and teachers)."""
    return _signature([t.get("description"), list(t.get("teachers") or [])])


def _window(seconds_left: int) -> Optional[str]:
    """The time milestone whose window holds ``seconds_left`` (None: farther than the largest one)."""
    return next((m for m, threshold in MILESTONE_THRESHOLDS if seconds_left <= threshold), None)


def milestones_to_rearm(old_due: int, new_due: int, now: int) -> List[str]:
    """Time milestones to forget because a deadline moved later.

    Every milestone whose threshold lies before the new deadline fires again, and so does the window
    the task is in now when that is a different (larger) window than before. A shift that stays
    inside the current window keeps that window's row, and ``new`` is never re-armed.
    """
    if not old_due or not new_due or new_due <= old_due:
        return []
    new_left = new_due - now
    keys = [m for m, threshold in MILESTONE_THRESHOLDS if new_left > threshold]
    current = _window(new_left)
    if current is not None and current != _window(old_due - now):
        keys.append(current)
    return keys


def _owner(t: Dict) -> str:
    return str(t.get("user_id") or "")


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
        # Owners whose tasks were fully re-mirrored by this process (the first save always is).
        self._full_mirrored_owners: Set[str] = set()

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

            # Columns added after the first release (legacy rows stay NULL): the owner, and the
            # fingerprints that keep unchanged tasks from being mirrored again every round.
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
            for name in ("user_id", "mirror_sig", "details_sig", "details_updated_at"):
                if name not in columns:
                    conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} TEXT")
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
        if self.supabase.is_configured and not is_local_only_setting(key):
            self.supabase.upsert_setting(key, value)

    def save_tasks(self, tasks: List[Dict], mirror_async: bool = False) -> Tuple[List[Dict], List[Dict]]:
        """
        Inserta o actualiza las tareas recolectadas.
        Retorna: (tareas_nuevas, tareas_actualizadas)

        Only new or changed tasks are mirrored to Supabase; every task of an owner is re-sent once
        per process, once a day, and after a failed mirror. A deadline that moved later re-arms the
        time milestones that lie before it again (see ``milestones_to_rearm``).

        The Supabase mirror runs inline by default so ``last_task_mirror_ok`` is known (and
        milestones can be ordered after their tasks) when this returns; ``mirror_async=True``
        (UI thread) fires it in the background and leaves the outcome unknown.
        """
        new_tasks = []
        updated_tasks = []
        changed_ids: Set[str] = set()
        rearmed: List[Tuple[str, List[str]]] = []
        now = int(time.time())

        with self._get_conn() as conn:
            for t in tasks:
                task_id = t["id"]
                cur = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,))
                existing = cur.fetchone()
                details_sig = details_signature(t)

                if existing is None:
                    # Nueva tarea detectada
                    conn.execute("""
                        INSERT INTO tasks (
                            id, title, course, due_date_str, due_timestamp,
                            task_url, status, first_seen, last_updated, is_notified, is_dismissed, user_id,
                            mirror_sig, details_sig, details_updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
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
                        mirror_signature(t),
                        details_sig,
                        t.get("details_updated_at"),
                    ))
                    new_tasks.append(t)
                    changed_ids.add(str(task_id))
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
                    # Unchanged details keep the time they were first seen with (the DB trigger does
                    # the same), so an unchanged task really is unchanged.
                    if (
                        t.get("details_updated_at")
                        and existing["details_updated_at"]
                        and existing["details_sig"] == details_sig
                    ):
                        t["details_updated_at"] = existing["details_updated_at"]
                    new_due = t.get("due_timestamp", existing["due_timestamp"])
                    keys = self._rearm_milestones(conn, str(task_id), existing["due_timestamp"], new_due, now)
                    if keys:
                        rearmed.append((str(task_id), keys))
                    sig = mirror_signature(t)
                    # Actualizar campos
                    conn.execute("""
                        UPDATE tasks SET
                            title = ?,
                            course = ?,
                            due_date_str = ?,
                            due_timestamp = ?,
                            task_url = ?,
                            status = ?,
                            last_updated = ?,
                            mirror_sig = ?,
                            details_sig = ?,
                            details_updated_at = ?
                        WHERE id = ?
                    """, (
                        t["title"],
                        t.get("course", existing["course"]),
                        t.get("due_date_str", existing["due_date_str"]),
                        new_due,
                        t.get("task_url", existing["task_url"]),
                        new_status,
                        now,
                        sig,
                        details_sig,
                        t.get("details_updated_at", existing["details_updated_at"]),
                        task_id,
                    ))
                    updated_tasks.append(t)
                    if sig != existing["mirror_sig"]:
                        changed_ids.add(str(task_id))

            self._forget_absent_signatures(conn, tasks)
            conn.commit()

        self._forget_remote_milestones(rearmed)

        if self.supabase.is_configured and tasks:
            full_owners = self._full_mirror_owners(tasks, now)
            send = changed_ids | self._unmirrored_tasks
            rows = [t for t in tasks if str(t["id"]) in send or _owner(t) in full_owners]
            self._mirror_tasks(rows, mirror_async, full_owners, now)

        return new_tasks, updated_tasks

    @staticmethod
    def _forget_absent_signatures(conn, tasks: List[Dict]):
        """Clear the mirror fingerprint of an owner's stored tasks that this fetch did not return.

        Such a task may be flagged ``missing_since`` remotely; if Moodle returns it again, it must be
        re-sent (clearing that flag) even though its values did not change.
        """
        present: Dict[str, Set[str]] = collections.defaultdict(set)
        for t in tasks:
            if _owner(t):
                present[_owner(t)].add(str(t["id"]))
        for owner, ids in present.items():
            stale = [
                (row["id"],)
                for row in conn.execute(
                    "SELECT id FROM tasks WHERE user_id = ? AND mirror_sig IS NOT NULL", (owner,)
                )
                if str(row["id"]) not in ids
            ]
            if stale:
                conn.executemany("UPDATE tasks SET mirror_sig = NULL WHERE id = ?", stale)

    @staticmethod
    def _rearm_milestones(conn, task_id: str, old_due, new_due, now: int) -> List[str]:
        """Delete the local milestones a later deadline re-arms; returns the deleted keys."""
        try:
            keys = milestones_to_rearm(int(old_due or 0), int(new_due or 0), now)
        except (TypeError, ValueError):
            return []
        if not keys:
            return []
        marks = ",".join("?" for _ in keys)
        present = [
            row["milestone"]
            for row in conn.execute(
                f"SELECT milestone FROM task_milestones WHERE task_id = ? AND milestone IN ({marks})",
                (task_id, *keys),
            )
        ]
        if present:
            marks = ",".join("?" for _ in present)
            conn.execute(
                f"DELETE FROM task_milestones WHERE task_id = ? AND milestone IN ({marks})", (task_id, *present)
            )
        return present

    def _forget_remote_milestones(self, rearmed: List[Tuple[str, List[str]]]):
        """Drop re-armed milestones from the deferred queue and from Supabase (inline, before any re-send)."""
        for task_id, keys in rearmed:
            print(f"[Storage] Deadline of task {task_id[:12]} moved later: re-armed milestones {', '.join(keys)}.")
            if self._deferred_milestones:
                kept = [m for m in self._deferred_milestones if not (m[0] == task_id and m[1] in keys)]
                self._deferred_milestones.clear()
                self._deferred_milestones.extend(kept)
            delete = getattr(self.supabase, "delete_milestones", None)
            if self.supabase.is_configured and delete is not None:
                if delete(task_id, keys) is False:
                    print(f"[Storage] Could not delete the re-armed milestones of task {task_id[:12]} in Supabase.")

    @staticmethod
    def _full_mirror_key(owner: str) -> str:
        return f"last_full_task_mirror_at:{owner}" if owner else "last_full_task_mirror_at"

    def _full_mirror_owners(self, tasks: List[Dict], now: int) -> Set[str]:
        """Owners whose every task must be re-sent: after a failed mirror, once per process and daily."""
        owners = {_owner(t) for t in tasks}
        if self.last_task_mirror_ok is False:
            return owners
        due = set()
        for owner in owners:
            if owner not in self._full_mirrored_owners:
                due.add(owner)
                continue
            try:
                last = int(self.get_setting(self._full_mirror_key(owner), "0") or 0)
            except ValueError:
                last = 0
            if now - last >= FULL_TASK_MIRROR_EVERY:
                due.add(owner)
        return due

    def _mirror_tasks(self, tasks: List[Dict], mirror_async: bool, full_owners: Iterable[str] = (), now: int = 0):
        if not tasks:
            # Nothing changed: no remote write. Milestones waiting for an earlier task row may go now.
            self.last_task_mirror_ok = True
            self._flush_deferred_milestones()
            return
        ok = self.supabase.upsert_tasks(tasks, async_call=mirror_async)
        self.last_task_mirror_ok = ok
        ids = {str(t["id"]) for t in tasks}
        if ok is False:
            self._unmirrored_tasks |= ids
            print(f"[Storage] Supabase task mirror FAILED for {len(ids)} tasks; milestones are deferred.")
        elif ok is True:
            self._unmirrored_tasks -= ids
            for owner in full_owners:
                self._full_mirrored_owners.add(owner)
                self.set_setting(self._full_mirror_key(owner), str(now or int(time.time())))
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

    def record_milestone(self, task_id: str, milestone: str, mirror: bool = True):
        """Registra que un hito ya fue notificado para no repetir spam.

        Only the first record of a (task, milestone) is mirrored: a repeated call changes nothing
        locally and sends nothing. ``mirror=False`` keeps it local: class reminders have no row in
        moodle_tasks, so mirroring them would only fail the table's foreign key.
        """
        now = int(time.time())
        with self._get_conn() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO task_milestones (task_id, milestone, sent_at) VALUES (?, ?, ?)",
                (task_id, milestone, now),
            )
            inserted = cur.rowcount == 1
            conn.commit()
        if not (inserted and mirror and self.supabase.is_configured):
            return
        if task_id in self._unmirrored_tasks:
            # Its task row is missing remotely: the insert would only fail (FK 409).
            if not self._deferred_milestones:
                print("[Storage] Skipping Supabase milestone mirror: task upsert failed this round.")
            self._deferred_milestones.append((task_id, milestone, now))
            return
        try:
            result = self.supabase.upsert_milestone(task_id, milestone, now)
        except Exception as exc:  # noqa: BLE001 - e.g. the mirror thread could not start
            print(f"[Storage] Supabase milestone mirror failed ({type(exc).__name__}); deferred.")
            result = False
        if result is False:
            self._deferred_milestones.append((task_id, milestone, now))

    # ---- recovery and housekeeping -------------------------------------------------------------------

    def hydrate_from_remote(self, supabase=None) -> Dict:
        """Restore the dedupe state from Supabase when the local milestones table is empty.

        After a lost or fresh SQLite file this copies the milestones of the last ``HYDRATE_DAYS`` days
        (and every ``new`` one) plus the per-user first-sync and token-alert flags, so nothing is
        announced again. A no-op when local milestones exist or Supabase is not configured. Returns
        the counts (``milestones``, ``settings``) or ``{"error": ...}``; never raises.
        """
        client = supabase if supabase is not None else self.supabase
        try:
            if client is None or not getattr(client, "is_configured", False):
                return {"skipped": "not_configured", "milestones": 0, "settings": 0}
            with self._get_conn() as conn:
                if conn.execute("SELECT 1 FROM task_milestones LIMIT 1").fetchone() is not None:
                    return {"skipped": "local_state_present", "milestones": 0, "settings": 0}
            # Read everything first: a partial restore would make the next start skip the rest.
            milestones = client.fetch_milestones_since(HYDRATE_DAYS)
            settings = []
            for prefix in HYDRATED_SETTING_PREFIXES:
                settings.extend(client.fetch_settings_like(prefix))
            restored_m = restored_s = 0
            with self._get_conn() as conn:
                for row in milestones:
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO task_milestones (task_id, milestone, sent_at) VALUES (?, ?, ?)",
                        (str(row["task_id"]), str(row["milestone"]), row.get("sent_at")),
                    )
                    restored_m += cur.rowcount
                for row in settings:
                    if row.get("value") is None:
                        continue
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (str(row["key"]), str(row["value"]))
                    )
                    restored_s += cur.rowcount
                conn.commit()
            print(f"[Storage] Hydrated from Supabase: {restored_m} milestones, {restored_s} settings.")
            return {"milestones": restored_m, "settings": restored_s}
        except Exception as exc:  # noqa: BLE001 - startup must go on without the remote state
            message = f"{type(exc).__name__}: {str(exc)[:200]}"
            print(f"[Storage] Could not hydrate from Supabase ({message}).")
            return {"error": message}

    def prune_stale_class_keys(self, days: int = 14) -> int:
        """Delete local class-reminder keys sent more than ``days`` days ago; returns how many.

        Class reminders are keyed per date (``class:<id>:<date>`` for imported schedules,
        ``class_<id>_<date>`` for the built-in one), so old keys are never read again.
        """
        cutoff = int(time.time()) - int(days) * 86400
        with self._get_conn() as conn:
            cur = conn.execute(
                "DELETE FROM task_milestones WHERE (task_id LIKE 'class:%' OR task_id LIKE 'class\\_%' ESCAPE '\\')"
                " AND sent_at < ?",
                (cutoff,),
            )
            conn.commit()
            return cur.rowcount
