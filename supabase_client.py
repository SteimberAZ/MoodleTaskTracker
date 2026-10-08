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
        # moodle_users.ntfy_enabled arrives with the Web Push migration. Until supabase_schema.sql has
        # been re-run the server rejects any select of it, so the reads below drop it once and ntfy
        # stays on for everybody.
        self._ntfy_enabled_supported = True

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

        ``is_dismissed`` is deliberately absent: the web owns "muted" (Supabase is the source of
        truth), and with merge-duplicates an omitted column keeps the stored value on update while
        new rows get the column default (0).
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
            # Every row needs an owner (moodle_tasks.user_id is NOT NULL).
            "user_id": t["user_id"],
            "assign_id": t.get("assign_id"),
            "course_module_id": t.get("course_module_id"),
            # Details for the web (teachers is a JSON array of names, NOT NULL in the schema).
            "description": t.get("description"),
            "course_id": t.get("course_id"),
            "module": t.get("module"),
            "teachers": list(t.get("teachers") or []),
            "details_updated_at": t.get("details_updated_at"),
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

    def _ntfy_enabled_rejected(self, r) -> bool:
        """True (remembered) when the server refused ntfy_enabled because the column does not exist yet."""
        if (
            self._ntfy_enabled_supported
            and r.status_code == 400
            and "ntfy_enabled" in str(getattr(r, "text", "") or "")
        ):
            self._ntfy_enabled_supported = False
            print("[Supabase] moodle_users.ntfy_enabled does not exist yet (re-run supabase_schema.sql); ntfy stays on for everyone.")
            return True
        return False

    def _get_users(self, filters: Dict[str, str], select: str):
        """GET moodle_users with ``select`` plus ntfy_enabled, repeating without it if the column is missing."""
        url = f"{self.url}/rest/v1/moodle_users"
        wanted = f"{select},ntfy_enabled" if self._ntfy_enabled_supported else select
        r = requests.get(url, params={**filters, "select": wanted}, headers=self._headers(), timeout=10)
        if self._ntfy_enabled_rejected(r):
            r = requests.get(url, params={**filters, "select": select}, headers=self._headers(), timeout=10)
        return r

    def fetch_active_users(self) -> List[Dict]:
        """Active users that have a Moodle token (the worker's sync set).

        Returns [] when Supabase is not configured. RAISES on any transport/HTTP failure so the
        caller can tell "no users" apart from "could not read users".
        """
        if not self.is_configured:
            return []
        select = "id,moodle_url,site_userid,username,fullname,token,ntfy_topic,is_admin,last_error,last_error_at,last_login_at"
        r = self._get_users({"active": "eq.true", "token": "not.is.null"}, select)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [u for u in r.json() if str(u.get("token") or "").strip()]

    def fetch_admin_users(self) -> List[Dict]:
        """Active admin users (``id``, ``ntfy_topic``, ``ntfy_enabled``): the recipients of owner-only alerts.

        Returns [] when Supabase is not configured. RAISES on any transport/HTTP failure so the
        caller can tell "no admin" apart from "could not read the admins".
        """
        if not self.is_configured:
            return []
        r = self._get_users({"is_admin": "eq.true", "active": "eq.true"}, "id,ntfy_topic")
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [u for u in r.json() if isinstance(u, dict) and u.get("id")]

    def fetch_muted_task_ids(self, user_id: str) -> set:
        """Ids of the tasks this user muted from the web (``is_dismissed = 1``).

        Returns an empty set when Supabase is not configured. RAISES on any transport/HTTP failure so
        the caller can tell "nothing muted" apart from "could not read the mutes".
        """
        if not self.is_configured:
            return set()
        params = {"user_id": f"eq.{user_id}", "is_dismissed": "eq.1", "select": "id"}
        r = requests.get(f"{self.url}/rest/v1/moodle_tasks", params=params, headers=self._headers(), timeout=10)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return {str(row["id"]) for row in r.json() if isinstance(row, dict) and row.get("id")}

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

        Each row embeds its owner as ``moodle_users: {ntfy_topic, active, ntfy_enabled}`` (the delivery
        targets; ntfy_enabled is left out until the column exists).
        """
        if not self.is_configured:
            return []
        try:
            endpoint = f"{self.url}/rest/v1/moodle_custom_reminders"
            owner = "ntfy_topic,active,ntfy_enabled" if self._ntfy_enabled_supported else "ntfy_topic,active"
            params = {
                "select": f"*,moodle_users({owner})",
                "active": "eq.true",
                "next_fire_at": f"lte.{now_iso}",
                "user_id": "not.is.null",
                "order": "next_fire_at.asc",
            }
            r = requests.get(endpoint, params=params, headers=self._headers(), timeout=10)
            if self._ntfy_enabled_rejected(r):
                params["select"] = "*,moodle_users(ntfy_topic,active)"
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

    # ---- Web Push subscriptions (moodle_push_subscriptions) ------------------------------------------

    def fetch_push_subscriptions(self, user_id: str) -> List[Dict]:
        """Web Push subscriptions of one user (``id, endpoint, p256dh, auth, failure_count``).

        Returns [] when Supabase is not configured. RAISES on any transport/HTTP failure so the
        caller can tell "no subscriptions" apart from "could not read them".
        """
        if not self.is_configured:
            return []
        params = {"user_id": f"eq.{user_id}", "select": "id,endpoint,p256dh,auth,failure_count"}
        r = requests.get(
            f"{self.url}/rest/v1/moodle_push_subscriptions", params=params, headers=self._headers(), timeout=10
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [row for row in r.json() if isinstance(row, dict) and row.get("endpoint")]

    def fetch_push_test_requests(self) -> List[Dict]:
        """Subscriptions whose owner pressed "Enviar prueba" (``test_requested_at`` set by the web).

        Same contract as ``fetch_push_subscriptions``: [] when unconfigured, RAISES on failure.
        """
        if not self.is_configured:
            return []
        params = {
            "test_requested_at": "not.is.null",
            "select": "id,user_id,endpoint,p256dh,auth,failure_count",
        }
        r = requests.get(
            f"{self.url}/rest/v1/moodle_push_subscriptions", params=params, headers=self._headers(), timeout=10
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [row for row in r.json() if isinstance(row, dict) and row.get("endpoint")]

    def update_push_subscription(self, sub_id: str, fields: Dict) -> bool:
        """PATCH one subscription row (health fields, ``test_requested_at``)."""
        if not self.is_configured:
            return False
        try:
            headers = dict(self._headers())
            headers["Prefer"] = "return=minimal"
            r = requests.patch(
                f"{self.url}/rest/v1/moodle_push_subscriptions",
                params={"id": f"eq.{sub_id}"},
                json=fields,
                headers=headers,
                timeout=10,
            )
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] update_push_subscription error: {type(e).__name__}")
            return False

    def delete_push_subscription(self, sub_id: str) -> bool:
        """DELETE one subscription row (the browser unsubscribed or the row kept failing)."""
        if not self.is_configured:
            return False
        try:
            headers = dict(self._headers())
            headers["Prefer"] = "return=minimal"
            r = requests.delete(
                f"{self.url}/rest/v1/moodle_push_subscriptions",
                params={"id": f"eq.{sub_id}"},
                headers=headers,
                timeout=10,
            )
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] delete_push_subscription error: {type(e).__name__}")
            return False
