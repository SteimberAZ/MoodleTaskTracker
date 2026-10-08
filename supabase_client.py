import os
import threading
from typing import Dict, List, Optional
import requests


def _load_env_file():
    """Carga variables desde .env si existe sin requerir dependencias externas."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                val = v.strip()
                if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                    val = val[1:-1]
                os.environ.setdefault(k.strip(), val)
    except Exception:
        pass


_load_env_file()

# Max characters of a Supabase response body / exception text written to the logs.
_LOG_BODY_MAX = 300


class SupabaseClient:
    """Cliente ligero para sincronizar datos con Supabase vía REST API."""

    def __init__(self, url: Optional[str] = None, key: Optional[str] = None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        # `key` is the bearer token sent in Authorization; `apikey` is the gateway key.
        #
        # Recommended setup: MOODLE_DB_JWT is a long-lived JWT with claim role=moodle_app
        # (see scripts/make_moodle_jwt.py). The gateway validates the `apikey` header against
        # the instance keys, so it carries the public ANON key; PostgREST then switches to the
        # moodle_app role from the bearer JWT. If no anon key is set, the JWT is used for both.
        #
        # Legacy fallback (no MOODLE_DB_JWT): service-role key, then SUPABASE_KEY, then anon.
        jwt = os.environ.get("MOODLE_DB_JWT", "").strip()
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if key:
            self.key = key
            self.apikey = key
        elif jwt:
            self.key = jwt
            self.apikey = anon or jwt
        else:
            self.key = (
                os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
                or os.environ.get("SUPABASE_KEY", "")
                or anon
            )
            self.apikey = self.key

    @classmethod
    def for_worker(cls) -> "SupabaseClient":
        """Client for server-side processes (VPS worker, storage mirror).

        Uses MOODLE_DB_JWT (+ SUPABASE_ANON_KEY) when set, otherwise the legacy
        service-role/SUPABASE_KEY chain.
        """
        return cls()

    # Backwards-compatible alias for the previous name.
    for_service_role = for_worker

    @property
    def is_configured(self) -> bool:
        return bool(self.url and self.key)

    def _headers(self) -> Dict[str, str]:
        return {
            "apikey": self.apikey,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        }

    def _post(self, op: str, path: str, payload) -> bool:
        """POST a write and report success. Logs the status and a truncated body on non-2xx.

        Never logs headers or tokens. Never raises: a failed mirror must not break a sync round.
        """
        try:
            r = requests.post(f"{self.url}/rest/v1/{path}", json=payload, headers=self._headers(), timeout=5)
        except Exception as e:
            print(f"[Supabase] {op} error: {type(e).__name__}: {str(e)[:_LOG_BODY_MAX]}")
            return False
        status = getattr(r, "status_code", 0)
        if isinstance(status, int) and 200 <= status < 300:
            return True
        body = str(getattr(r, "text", "") or "")[:_LOG_BODY_MAX]
        print(f"[Supabase] {op} HTTP {status}: {body}")
        return False

    def _run(self, work, async_call: bool) -> Optional[bool]:
        """Run ``work`` inline (returns its bool result) or on a daemon thread (returns None)."""
        if async_call:
            threading.Thread(target=work, daemon=True).start()
            return None
        return work()

    @staticmethod
    def _task_row(t: Dict) -> Dict:
        """One moodle_tasks row. Every row carries the same keys.

        PostgREST rejects a bulk insert whose rows have different key sets (PGRST102), so the
        optional web-service columns are always present and null when unknown.
        """
        return {
            "id": str(t["id"]),
            "title": t["title"],
            "course": t.get("course", "Materia no especificada"),
            "due_date_str": t.get("due_date_str", ""),
            "due_timestamp": t.get("due_timestamp", 0),
            "task_url": t.get("task_url", ""),
            "status": t.get("status", "pending"),
            "first_seen": t.get("first_seen", 0),
            "last_updated": t.get("last_updated", 0),
            "is_notified": t.get("is_notified", 0),
            "is_dismissed": t.get("is_dismissed", 0),
            # Every row needs an owner (moodle_tasks.user_id is NOT NULL).
            "user_id": t["user_id"],
            "assign_id": t.get("assign_id"),
            "course_module_id": t.get("course_module_id"),
        }

    def upsert_tasks(self, tasks: List[Dict], async_call: bool = True) -> Optional[bool]:
        """Upsert tasks into moodle_tasks.

        Returns True when Supabase accepted the batch (or there was nothing to send), False when the
        request failed (the reason is logged), and None for ``async_call=True`` (outcome unknown).
        """
        # Rows without an owner (legacy single-user path) would be rejected by the
        # NOT NULL user_id column and take the whole batch with them: mirror only owned rows.
        tasks = [t for t in (tasks or []) if t.get("user_id")]
        if not self.is_configured or not tasks:
            return True

        def _do_upsert() -> bool:
            try:
                # One row per id: a duplicate inside a single upsert makes Postgres fail the batch.
                rows = {str(t["id"]): self._task_row(t) for t in tasks}
                return self._post("upsert_tasks", "moodle_tasks?on_conflict=id", list(rows.values()))
            except Exception as e:
                print(f"[Supabase] upsert_tasks error: {type(e).__name__}: {str(e)[:_LOG_BODY_MAX]}")
                return False

        return self._run(_do_upsert, async_call)

    def upsert_milestone(self, task_id: str, milestone: str, sent_at: int, async_call: bool = True) -> Optional[bool]:
        """Registra un hito en la tabla moodle_task_milestones de Supabase (bool as upsert_tasks)."""
        if not self.is_configured:
            return True

        def _do_upsert() -> bool:
            payload = {"task_id": str(task_id), "milestone": str(milestone), "sent_at": sent_at}
            return self._post("upsert_milestone", "moodle_task_milestones", payload)

        return self._run(_do_upsert, async_call)

    def upsert_setting(self, key: str, value: str, async_call: bool = True) -> Optional[bool]:
        """Sincroniza un ajuste en moodle_settings (bool as upsert_tasks)."""
        if not self.is_configured:
            return True

        def _do_upsert() -> bool:
            return self._post("upsert_setting", "moodle_settings", {"key": str(key), "value": str(value)})

        return self._run(_do_upsert, async_call)

    def fetch_tasks(self) -> List[Dict]:
        """Recupera todas las tareas registradas en la nube."""
        if not self.is_configured:
            return []
        try:
            endpoint = f"{self.url}/rest/v1/moodle_tasks?select=*&order=due_timestamp.asc"
            r = requests.get(endpoint, headers=self._headers(), timeout=8)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return []

    def fetch_active_users(self) -> List[Dict]:
        """Active users that have a Moodle token (the worker's sync set).

        Returns [] when Supabase is not configured. RAISES on any transport/HTTP failure so the
        caller can tell "no users" apart from "could not read users".
        """
        if not self.is_configured:
            return []
        params = {
            "active": "eq.true",
            "token": "not.is.null",
            "select": "id,moodle_url,site_userid,username,fullname,token,ntfy_topic,is_admin,last_error,last_error_at,last_login_at",
        }
        r = requests.get(f"{self.url}/rest/v1/moodle_users", params=params, headers=self._headers(), timeout=10)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [u for u in r.json() if str(u.get("token") or "").strip()]

    def update_user(self, user_id: str, fields: Dict) -> bool:
        """PATCH one moodle_users row (e.g. last_error / last_error_at)."""
        if not self.is_configured:
            return False
        try:
            headers = dict(self._headers())
            headers["Prefer"] = "return=minimal"
            r = requests.patch(
                f"{self.url}/rest/v1/moodle_users",
                params={"id": f"eq.{user_id}"},
                json=fields,
                headers=headers,
                timeout=10,
            )
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] update_user error: {e}")
            return False

    def fetch_credentials(self) -> Optional[Dict]:
        """The single moodle_credentials row (id=1), or None when absent/unreadable."""
        if not self.is_configured:
            return None
        endpoint = f"{self.url}/rest/v1/moodle_credentials"
        r = requests.get(endpoint, params={"id": "eq.1", "select": "*"}, headers=self._headers(), timeout=10)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        rows = r.json()
        return rows[0] if rows else None

    def update_credentials(self, fields: Dict) -> bool:
        """PATCH the moodle_credentials row (e.g. last_error / last_error_at)."""
        if not self.is_configured:
            return False
        try:
            headers = dict(self._headers())
            headers["Prefer"] = "return=minimal"
            r = requests.patch(
                f"{self.url}/rest/v1/moodle_credentials",
                params={"id": "eq.1"},
                json=fields,
                headers=headers,
                timeout=10,
            )
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] update_credentials error: {e}")
            return False

    def fetch_due_reminders(self, now_iso: str) -> List[Dict]:
        """Active, owned custom reminders whose next_fire_at is due (synchronous).

        Each row embeds its owner as ``moodle_users: {ntfy_topic, active}`` (the delivery topic).
        """
        if not self.is_configured:
            return []
        try:
            endpoint = f"{self.url}/rest/v1/moodle_custom_reminders"
            params = {
                "select": "*,moodle_users(ntfy_topic,active)",
                "active": "eq.true",
                "next_fire_at": f"lte.{now_iso}",
                "user_id": "not.is.null",
                "order": "next_fire_at.asc",
            }
            r = requests.get(endpoint, params=params, headers=self._headers(), timeout=10)
            if r.status_code == 200:
                return r.json()
            print(f"[Supabase] fetch_due_reminders HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"[Supabase] fetch_due_reminders error: {e}")
        return []

    def update_reminder(self, reminder_id: str, fields: Dict) -> bool:
        """PATCH a custom reminder row (synchronous)."""
        if not self.is_configured:
            return False
        try:
            endpoint = f"{self.url}/rest/v1/moodle_custom_reminders"
            headers = dict(self._headers())
            headers["Prefer"] = "return=minimal"
            r = requests.patch(
                endpoint, params={"id": f"eq.{reminder_id}"}, json=fields, headers=headers, timeout=10
            )
            if r.status_code in (200, 204):
                return True
            print(f"[Supabase] update_reminder HTTP {r.status_code}: {r.text[:200]}")
        except Exception as e:
            print(f"[Supabase] update_reminder error: {e}")
        return False
