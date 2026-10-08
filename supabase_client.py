import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


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

# Max ids per ``in.(...)`` filter, so the URL stays short for any number of rows.
_ID_CHUNK = 50

# Seconds a single write may take. Bulk writes (task upserts, history inserts) carry many rows.
_WRITE_TIMEOUT = 5
_BULK_TIMEOUT = 15
# Seconds to open a connection. Every call's timeout becomes (connect, read): a black-holed or
# overloaded Supabase then costs a few seconds per call, not three full read timeouts.
_CONNECT_TIMEOUT = 3.05

# Paged reads: rows per request and an upper bound of requests per read.
_PAGE_SIZE = 1000
_MAX_PAGES = 200

# Newest Web Push subscriptions read per user: a flood of stale rows must not stall a delivery.
PUSH_SUBSCRIPTIONS_LIMIT = 10

_MILESTONES_PREFER = "resolution=ignore-duplicates,return=minimal"

# Columns added by later supabase_schema.sql migrations. Each one is used until the server rejects
# it, then dropped for the life of the process (see OptionalColumns).
OPTIONAL_COLUMNS: Dict[str, Tuple[str, ...]] = {
    "moodle_users": ("ntfy_enabled", "ntfy_confirmed_at", "last_synced_at"),
    "moodle_push_subscriptions": ("last_failure_reason",),
    "moodle_notification_log": ("push_state",),
    "moodle_tasks": ("missing_since",),
}

# Optional user columns appended to every moodle_users select (ntfy_enabled last).
_USER_OPTIONAL = ("ntfy_confirmed_at", "ntfy_enabled")
_SYNC_USER_OPTIONAL = ("ntfy_confirmed_at", "last_synced_at", "ntfy_enabled")
_SYNC_USER_SELECT = (
    "id,moodle_url,site_userid,username,fullname,token,ntfy_topic,is_admin,last_error,last_error_at,last_login_at"
)

# Pseudo column of moodle_custom_reminders: the ``task:moodle_tasks(...)`` embed needs the task_id FK.
_REMINDER_TASK_EMBED = "task_embed"


def _build_session() -> requests.Session:
    """Shared HTTP session: pooled connections and up to two retries of an idempotent GET on 502/503/504.

    A connection that could not be opened is retried once; a read timeout is never retried (the
    server is stalled: another full wait would only delay the deliveries behind this call).
    """
    retry = Retry(
        total=2,
        connect=1,
        read=0,
        backoff_factor=0.5,
        status_forcelist=(502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
        respect_retry_after_header=False,
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


_SESSION = _build_session()

# The module-level requests functions as imported. Tests replace ``requests.<verb>``; that
# replacement is honoured so they keep intercepting every call.
_MODULE_VERBS = {verb: getattr(requests, verb) for verb in ("get", "post", "patch", "delete")}


def _transport(verb: str):
    current = getattr(requests, verb)
    if current is not _MODULE_VERBS[verb]:
        return current
    return getattr(_SESSION, verb)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ok(r) -> bool:
    status = getattr(r, "status_code", 0)
    return isinstance(status, int) and 200 <= status < 300


def _body(r) -> str:
    return str(getattr(r, "text", "") or "")[:_LOG_BODY_MAX]


_missing_jwt_logged = False


def _log_missing_jwt() -> None:
    global _missing_jwt_logged
    if not _missing_jwt_logged:
        _missing_jwt_logged = True
        print(
            "[Supabase] ERROR: MOODLE_DB_JWT is not set, so the database is NOT used. The service-role / "
            "SUPABASE_KEY fallback was removed: create the JWT with scripts/make_moodle_jwt.py."
        )


def _error_message(response) -> str:
    """The ``message`` of a PostgREST/Postgres error body, else the raw text.

    The Postgres ``hint`` ("Perhaps you meant to reference the column ...") can name a column that
    DOES exist, so only the message is matched when the body is the usual JSON object.
    """
    text = str(getattr(response, "text", "") or "")
    try:
        body = json.loads(text)
    except ValueError:
        return text
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return body["message"]
    return text


class OptionalColumns:
    """Columns that only exist once a later supabase_schema.sql migration ran.

    Each one is used until the server rejects it (HTTP 400 naming the column: PostgREST PGRST204 for
    a write, Postgres 42703 for a select); it is then switched off for the life of the process, with
    one log line, and never sent again.
    """

    def __init__(self, known: Optional[Dict[str, Sequence[str]]] = None):
        self._known = {t: tuple(cols) for t, cols in (known or OPTIONAL_COLUMNS).items()}
        self._off: set = set()

    def supported(self, table: str, column: str) -> bool:
        return (table, column) not in self._off

    def wanted(self, table: str, columns: Optional[Iterable[str]] = None) -> List[str]:
        cols = self._known.get(table, ()) if columns is None else columns
        return [c for c in cols if self.supported(table, c)]

    def disable(self, table: str, column: str) -> None:
        if (table, column) in self._off:
            return
        self._off.add((table, column))
        print(f"[Supabase] {table}.{column} does not exist yet (re-run supabase_schema.sql); continuing without it.")

    def reject(self, table: str, response, candidates: Optional[Iterable[str]] = None) -> Optional[str]:
        """Switch off the candidate column the error ``response`` names. Returns it, or None when unrelated."""
        if getattr(response, "status_code", 0) != 400:
            return None
        text = _error_message(response)
        for column in self.wanted(table, candidates):
            if column in text:
                self.disable(table, column)
                return column
        return None

    def strip(self, table: str, row):
        """``row`` (a dict) without the switched-off columns of ``table``."""
        if not isinstance(row, dict):
            return row
        off = [c for c in self._known.get(table, ()) if not self.supported(table, c)]
        if not off:
            return row
        return {k: v for k, v in row.items() if k not in off}


class SupabaseClient:
    """Cliente ligero para sincronizar datos con Supabase vía REST API."""

    def __init__(self, url: Optional[str] = None, key: Optional[str] = None, http: Any = None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        # `key` is the bearer token sent in Authorization; `apikey` is the gateway key.
        #
        # MOODLE_DB_JWT is a long-lived JWT with claim role=moodle_app (see scripts/make_moodle_jwt.py).
        # The gateway validates the `apikey` header against the instance keys, so it carries the public
        # ANON key; PostgREST then switches to the moodle_app role from the bearer JWT. If no anon key
        # is set, the JWT is used for both. Without MOODLE_DB_JWT the client is NOT configured (fail
        # closed): there is no service-role fallback, which would bypass row-level security.
        jwt = os.environ.get("MOODLE_DB_JWT", "").strip()
        anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        if key:
            self.key = key
            self.apikey = key
        elif jwt:
            self.key = jwt
            self.apikey = anon or jwt
        else:
            self.key = ""
            self.apikey = ""
            if self.url:
                _log_missing_jwt()
        # Injectable transport (an object with get/post/patch/delete); None = the shared session.
        self._http = http
        self.columns = OptionalColumns()

    @classmethod
    def for_worker(cls) -> "SupabaseClient":
        """Client for server-side processes (VPS worker, storage mirror): MOODLE_DB_JWT (+ SUPABASE_ANON_KEY)."""
        return cls()

    # Backwards-compatible alias for the previous name.
    for_service_role = for_worker

    @property
    def is_configured(self) -> bool:
        return bool(self.url and self.key)

    # ---- optional-column flags (True until the server rejected the column) ---------------------------

    def column_supported(self, table: str, column: str) -> bool:
        return self.columns.supported(table, column)

    @property
    def push_failure_reason_supported(self) -> bool:
        return self.columns.supported("moodle_push_subscriptions", "last_failure_reason")

    @property
    def ntfy_confirmed_at_supported(self) -> bool:
        return self.columns.supported("moodle_users", "ntfy_confirmed_at")

    @property
    def last_synced_at_supported(self) -> bool:
        return self.columns.supported("moodle_users", "last_synced_at")

    @property
    def push_state_supported(self) -> bool:
        return self.columns.supported("moodle_notification_log", "push_state")

    @property
    def missing_since_supported(self) -> bool:
        return self.columns.supported("moodle_tasks", "missing_since")

    # ---- transport -----------------------------------------------------------------------------------

    def _call(self, verb: str, url: str, **kwargs):
        fn = getattr(self._http, verb) if self._http is not None else _transport(verb)
        timeout = kwargs.get("timeout")
        if isinstance(timeout, (int, float)) and not isinstance(timeout, bool):
            kwargs["timeout"] = (min(_CONNECT_TIMEOUT, float(timeout)), float(timeout))
        return fn(url, **kwargs)

    def _endpoint(self, path: str) -> str:
        return f"{self.url}/rest/v1/{path}"

    def _headers(self) -> Dict[str, str]:
        return {
            "apikey": self.apikey,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        }

    def _headers_with(self, prefer: str) -> Dict[str, str]:
        headers = dict(self._headers())
        headers["Prefer"] = prefer
        return headers

    def _send_post(self, op: str, path: str, payload, timeout: float = _WRITE_TIMEOUT,
                   prefer: Optional[str] = None) -> Tuple[bool, Any]:
        """POST a write; returns (accepted, response or None). Logs non-2xx and transport errors, never raises."""
        headers = self._headers_with(prefer) if prefer else self._headers()
        try:
            r = self._call("post", self._endpoint(path), json=payload, headers=headers, timeout=timeout)
        except Exception as e:
            print(f"[Supabase] {op} error: {type(e).__name__}: {str(e)[:_LOG_BODY_MAX]}")
            return False, None
        if _ok(r):
            return True, r
        print(f"[Supabase] {op} HTTP {getattr(r, 'status_code', 0)}: {_body(r)}")
        return False, r

    def _post(self, op: str, path: str, payload, timeout: float = _WRITE_TIMEOUT,
              prefer: Optional[str] = None) -> bool:
        """POST a write and report success. Never logs headers or tokens; never raises."""
        return self._send_post(op, path, payload, timeout=timeout, prefer=prefer)[0]

    def _patch(self, path: str, params: Dict, fields: Dict, prefer: str = "return=minimal"):
        return self._call("patch", self._endpoint(path), params=params, json=fields,
                          headers=self._headers_with(prefer), timeout=10)

    def _get(self, path: str, params: Dict):
        return self._call("get", self._endpoint(path), params=params, headers=self._headers(), timeout=10)

    def _get_rows(self, path: str, params: Dict) -> List[Dict]:
        """GET rows (dicts only); RAISES RuntimeError on a non-200 response and on transport errors."""
        r = self._get(path, params)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [row for row in r.json() if isinstance(row, dict)]

    def _get_paged(self, path: str, params: Dict) -> List[Dict]:
        """All rows of a read, ``_PAGE_SIZE`` per request until an empty page. RAISES like ``_get_rows``."""
        rows: List[Dict] = []
        for _ in range(_MAX_PAGES):
            page = self._get_rows(path, {**params, "limit": str(_PAGE_SIZE), "offset": str(len(rows))})
            if not page:
                break
            rows.extend(page)
        return rows

    def _run(self, work, async_call: bool) -> Optional[bool]:
        """Run ``work`` inline (returns its bool result) or on a daemon thread (returns None)."""
        if async_call:
            threading.Thread(target=work, daemon=True).start()
            return None
        return work()

    @staticmethod
    def _id_chunks(user_ids: Iterable[str], size: int = _ID_CHUNK):
        ids = [str(i) for i in dict.fromkeys(user_ids or []) if i]
        for start in range(0, len(ids), size):
            yield ids[start : start + size]

    # ---- tasks and milestones ------------------------------------------------------------------------

    @staticmethod
    def _task_row(t: Dict, include_missing_since: bool = False) -> Dict:
        """One moodle_tasks row. Every row carries the same keys.

        PostgREST rejects a bulk insert whose rows have different key sets (PGRST102), so the
        optional web-service columns are always present and null when unknown.

        ``is_dismissed`` is deliberately absent: the web owns "muted" (Supabase is the source of
        truth), and with merge-duplicates an omitted column keeps the stored value on update while
        new rows get the column default (0). ``first_seen``, ``last_updated`` and ``is_notified`` are
        absent too, so a re-sent task keeps the stored values. ``missing_since`` is sent as null (a
        task that is fetched again is no longer missing) only once that column exists.
        """
        row = {
            "id": str(t["id"]),
            "title": t["title"],
            "course": t.get("course", "Materia no especificada"),
            "due_date_str": t.get("due_date_str", ""),
            "due_timestamp": t.get("due_timestamp", 0),
            "task_url": t.get("task_url", ""),
            "status": t.get("status", "pending"),
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
        if include_missing_since:
            row["missing_since"] = None
        return row

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
                with_missing = self.missing_since_supported
                # One row per id: a duplicate inside a single upsert makes Postgres fail the batch.
                rows = list({str(t["id"]): self._task_row(t, with_missing) for t in tasks}.values())
                path = "moodle_tasks?on_conflict=id"
                ok, r = self._send_post("upsert_tasks", path, rows, timeout=_BULK_TIMEOUT)
                if not ok and with_missing and self.columns.reject("moodle_tasks", r, ("missing_since",)):
                    rows = [self.columns.strip("moodle_tasks", row) for row in rows]
                    ok, _ = self._send_post("upsert_tasks", path, rows, timeout=_BULK_TIMEOUT)
                return ok
            except Exception as e:
                print(f"[Supabase] upsert_tasks error: {type(e).__name__}: {str(e)[:_LOG_BODY_MAX]}")
                return False

        return self._run(_do_upsert, async_call)

    def upsert_milestone(self, task_id: str, milestone: str, sent_at: int, async_call: bool = True) -> Optional[bool]:
        """Record a milestone in moodle_task_milestones (bool as upsert_tasks).

        The first ``sent_at`` is immutable: an existing (task_id, milestone) row is left untouched
        (ON CONFLICT DO NOTHING), so the web never shows a sent reminder with a later time.
        """
        if not self.is_configured:
            return True

        def _do_upsert() -> bool:
            payload = {"task_id": str(task_id), "milestone": str(milestone), "sent_at": sent_at}
            return self._post(
                "upsert_milestone", "moodle_task_milestones?on_conflict=task_id,milestone", payload,
                prefer=_MILESTONES_PREFER,
            )

        return self._run(_do_upsert, async_call)

    def delete_milestones(self, task_id: str, keys: Iterable[str]) -> bool:
        """DELETE the given milestones of one task (a deadline moved later re-arms them). Never raises."""
        keys = [str(k) for k in dict.fromkeys(keys or []) if k]
        if not self.is_configured or not keys:
            return True
        params = {"task_id": f"eq.{task_id}", "milestone": f"in.({','.join(keys)})"}
        try:
            r = self._call("delete", self._endpoint("moodle_task_milestones"), params=params,
                           headers=self._headers_with("return=minimal"), timeout=10)
        except Exception as e:
            print(f"[Supabase] delete_milestones error: {type(e).__name__}")
            return False
        if _ok(r):
            return True
        print(f"[Supabase] delete_milestones HTTP {getattr(r, 'status_code', 0)}: {_body(r)}")
        return False

    def fetch_milestones_since(self, days: int = 14, include_new: bool = True) -> List[Dict]:
        """Milestones sent in the last ``days`` days (``task_id, milestone, sent_at``), paged.

        ``include_new`` also returns every ``new`` milestone whatever its age: a task announced weeks
        ago can still be pending, and losing that row would announce it again. Returns [] when
        Supabase is not configured; RAISES on any transport/HTTP failure.
        """
        if not self.is_configured:
            return []
        cutoff = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
        params = {"select": "task_id,milestone,sent_at", "order": "task_id.asc,milestone.asc"}
        if include_new:
            params["or"] = f"(sent_at.gte.{cutoff},milestone.eq.new)"
        else:
            params["sent_at"] = f"gte.{cutoff}"
        rows = self._get_paged("moodle_task_milestones", params)
        return [r for r in rows if r.get("task_id") and r.get("milestone")]

    def upsert_setting(self, key: str, value: str, async_call: bool = True) -> Optional[bool]:
        """Sincroniza un ajuste en moodle_settings (bool as upsert_tasks)."""
        if not self.is_configured:
            return True

        def _do_upsert() -> bool:
            return self._post("upsert_setting", "moodle_settings", {"key": str(key), "value": str(value)})

        return self._run(_do_upsert, async_call)

    def fetch_settings_like(self, prefix: str) -> List[Dict]:
        """moodle_settings rows (``key, value``) whose key starts with ``prefix``, paged.

        Returns [] when Supabase is not configured; RAISES on any transport/HTTP failure.
        """
        if not self.is_configured:
            return []
        params = {"key": f"like.{prefix}*", "select": "key,value", "order": "key.asc"}
        return [r for r in self._get_paged("moodle_settings", params) if r.get("key")]

    def mark_tasks_missing(self, user_id: str, ids: Iterable[str]) -> Optional[bool]:
        """Stamp ``missing_since`` on tasks of ``user_id`` that Moodle no longer returns (once per task).

        Returns True when every request was accepted, False on a failure (logged), and None when the
        ``missing_since`` column does not exist yet (a no-op). Never raises.
        """
        if not self.is_configured or not self.missing_since_supported:
            return None if self.is_configured else False
        ok = True
        for chunk in self._id_chunks(ids):
            params = {"user_id": f"eq.{user_id}", "id": f"in.({','.join(chunk)})", "missing_since": "is.null"}
            try:
                r = self._patch("moodle_tasks", params, {"missing_since": _now_iso()})
            except Exception as e:
                print(f"[Supabase] mark_tasks_missing error: {type(e).__name__}")
                return False
            if self.columns.reject("moodle_tasks", r, ("missing_since",)):
                return None
            if not _ok(r):
                print(f"[Supabase] mark_tasks_missing HTTP {getattr(r, 'status_code', 0)}: {_body(r)}")
                ok = False
        return ok

    def _ntfy_enabled_rejected(self, r) -> bool:
        """True (remembered) when the server refused ntfy_enabled because the column does not exist yet."""
        return self.columns.reject("moodle_users", r, ("ntfy_enabled",)) is not None

    # ---- users ---------------------------------------------------------------------------------------

    def _get_users(self, filters: Dict[str, str], select: str, optional: Sequence[str] = _USER_OPTIONAL):
        """GET moodle_users with ``select`` plus the optional columns still supported.

        A 400 naming one of them drops it (remembered) and repeats the read without it.
        """
        r = None
        for _ in range(len(optional) + 1):
            wanted = ",".join([select] + self.columns.wanted("moodle_users", optional))
            r = self._get("moodle_users", {**filters, "select": wanted})
            if not self.columns.reject("moodle_users", r, optional):
                break
        return r

    def fetch_active_users(self) -> List[Dict]:
        """Active users that have a Moodle token (the worker's sync set).

        Returns [] when Supabase is not configured. RAISES on any transport/HTTP failure so the
        caller can tell "no users" apart from "could not read users".
        """
        if not self.is_configured:
            return []
        r = self._get_users({"active": "eq.true", "token": "not.is.null"}, _SYNC_USER_SELECT, _SYNC_USER_OPTIONAL)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [u for u in r.json() if isinstance(u, dict) and str(u.get("token") or "").strip()]

    def fetch_users_by_ids(self, ids: Iterable[str]) -> List[Dict]:
        """Full rows (as ``fetch_active_users``) of the given user ids, active or not, chunked.

        Returns [] when Supabase is not configured or there are no ids. RAISES on any failure.
        """
        if not self.is_configured:
            return []
        rows: List[Dict] = []
        for chunk in self._id_chunks(ids):
            r = self._get_users({"id": f"in.({','.join(chunk)})"}, _SYNC_USER_SELECT, _SYNC_USER_OPTIONAL)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            rows.extend(u for u in r.json() if isinstance(u, dict) and u.get("id"))
        return rows

    def fetch_login_markers(self) -> List[Dict]:
        """``[{id, last_login_at}]`` of the active users with a token. Selects NO token.

        A cheap poll to notice a new login without reading every user's secret. Returns [] when
        Supabase is not configured; RAISES on any transport/HTTP failure.
        """
        if not self.is_configured:
            return []
        params = {"active": "eq.true", "token": "not.is.null", "select": "id,last_login_at"}
        return [
            {"id": row["id"], "last_login_at": row.get("last_login_at")}
            for row in self._get_rows("moodle_users", params)
            if row.get("id")
        ]

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

    def set_user_synced(self, user_id: str) -> Optional[bool]:
        """Stamp ``moodle_users.last_synced_at = now``. None while that column does not exist; never raises."""
        if not self.is_configured:
            return False
        if not self.last_synced_at_supported:
            return None
        try:
            r = self._patch("moodle_users", {"id": f"eq.{user_id}"}, {"last_synced_at": _now_iso()})
        except Exception as e:
            print(f"[Supabase] set_user_synced error: {type(e).__name__}")
            return False
        if self.columns.reject("moodle_users", r, ("last_synced_at",)):
            return None
        return r.status_code in (200, 204)

    # ---- Imported class schedule (moodle_class_schedule) ---------------------------------------------

    def fetch_class_reminder_users(self) -> List[Dict]:
        """Active users that switched class reminders on (``class_reminder_minutes`` is not null).

        Rows carry ``id, ntfy_topic, ntfy_enabled, class_reminder_minutes, is_admin``. Returns []
        when Supabase is not configured. RAISES on any transport/HTTP failure (also while the
        ``class_reminder_minutes`` column does not exist yet) so the caller can tell "nobody asked"
        apart from "could not read".
        """
        if not self.is_configured:
            return []
        r = self._get_users(
            {"active": "eq.true", "class_reminder_minutes": "not.is.null"},
            "id,ntfy_topic,class_reminder_minutes,is_admin",
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return [u for u in r.json() if isinstance(u, dict) and u.get("id")]

    def fetch_class_schedule(self, user_ids: List[str], weekday: int) -> List[Dict]:
        """Class rows of ``user_ids`` for one ISO weekday (1 = Monday ... 7 = Sunday).

        Returns [] when Supabase is not configured or there are no ids. RAISES on any transport/HTTP
        failure so the caller can tell "no classes today" apart from "could not read them".
        """
        if not self.is_configured:
            return []
        rows: List[Dict] = []
        for chunk in self._id_chunks(user_ids):
            params = {"user_id": f"in.({','.join(chunk)})", "weekday": f"eq.{int(weekday)}", "select": "*"}
            rows.extend(row for row in self._get_rows("moodle_class_schedule", params) if row.get("id"))
        return rows

    def fetch_users_with_schedule(self, user_ids: List[str]) -> set:
        """Ids (str) among ``user_ids`` that have at least one imported class, on any weekday.

        Same contract as ``fetch_class_schedule``: empty set when unconfigured, RAISES on failure.
        """
        if not self.is_configured:
            return set()
        found: set = set()
        for chunk in self._id_chunks(user_ids):
            params = {"user_id": f"in.({','.join(chunk)})", "select": "user_id"}
            found.update(str(row["user_id"]) for row in self._get_rows("moodle_class_schedule", params)
                         if row.get("user_id"))
        return found

    def fetch_muted_task_ids(self, user_id: str) -> set:
        """Ids of the tasks this user muted from the web (``is_dismissed = 1``).

        Returns an empty set when Supabase is not configured. RAISES on any transport/HTTP failure so
        the caller can tell "nothing muted" apart from "could not read the mutes".
        """
        if not self.is_configured:
            return set()
        params = {"user_id": f"eq.{user_id}", "is_dismissed": "eq.1", "select": "id"}
        return {str(row["id"]) for row in self._get_rows("moodle_tasks", params) if row.get("id")}

    def update_user(self, user_id: str, fields: Dict) -> bool:
        """PATCH one moodle_users row (e.g. last_error / last_error_at)."""
        if not self.is_configured:
            return False
        try:
            r = self._patch("moodle_users", {"id": f"eq.{user_id}"}, fields)
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] update_user error: {e}")
            return False

    def fetch_credentials(self) -> Optional[Dict]:
        """The single moodle_credentials row (id=1), or None when absent/unreadable."""
        if not self.is_configured:
            return None
        rows = self._get_rows("moodle_credentials", {"id": "eq.1", "select": "*"})
        return rows[0] if rows else None

    def update_credentials(self, fields: Dict) -> bool:
        """PATCH the moodle_credentials row (e.g. last_error / last_error_at)."""
        if not self.is_configured:
            return False
        try:
            r = self._patch("moodle_credentials", {"id": "eq.1"}, fields)
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] update_credentials error: {e}")
            return False

    # ---- custom reminders (moodle_custom_reminders) --------------------------------------------------

    def _reminder_task_embed_rejected(self, r) -> bool:
        """True (remembered) when the ``task:moodle_tasks`` embed failed because task_id is not migrated yet."""
        text = str(getattr(r, "text", "") or "")
        if (
            self.columns.supported("moodle_custom_reminders", _REMINDER_TASK_EMBED)
            and getattr(r, "status_code", 0) == 400
            and "moodle_tasks" in text
            and ("relationship" in text or "PGRST200" in text or "task_id" in text)
        ):
            self.columns.disable("moodle_custom_reminders", _REMINDER_TASK_EMBED)
            return True
        return False

    def fetch_due_reminders(self, now_iso: str) -> List[Dict]:
        """Active, owned custom reminders whose next_fire_at is due (synchronous).

        Each row embeds its owner as ``moodle_users: {ntfy_topic, active, ntfy_confirmed_at, ntfy_enabled}``
        (an inner join filtered on active owners, so reminders of disabled users are not re-read every
        tick; optional columns are left out until they exist) and its linked task as
        ``task: {status, is_dismissed}`` or None. Never raises; [] on failure.
        """
        if not self.is_configured:
            return []
        try:
            r = None
            for _ in range(len(_USER_OPTIONAL) + 2):
                owner = ",".join(["ntfy_topic", "active"] + self.columns.wanted("moodle_users", _USER_OPTIONAL))
                select = f"*,moodle_users!inner({owner})"
                with_task = self.columns.supported("moodle_custom_reminders", _REMINDER_TASK_EMBED)
                if with_task:
                    select += ",task:moodle_tasks(status,is_dismissed)"
                params = {
                    "select": select,
                    "active": "eq.true",
                    "next_fire_at": f"lte.{now_iso}",
                    "user_id": "not.is.null",
                    "moodle_users.active": "eq.true",
                    "order": "next_fire_at.asc",
                }
                r = self._get("moodle_custom_reminders", params)
                if r.status_code == 200:
                    rows = [row for row in r.json() if isinstance(row, dict)]
                    if not with_task:
                        for row in rows:
                            row.setdefault("task", None)
                    return rows
                if self.columns.reject("moodle_users", r, _USER_OPTIONAL) or self._reminder_task_embed_rejected(r):
                    continue
                break
            print(f"[Supabase] fetch_due_reminders HTTP {r.status_code}: {str(r.text)[:200]}")
        except Exception as e:
            print(f"[Supabase] fetch_due_reminders error: {e}")
        return []

    def update_reminder(self, reminder_id: str, fields: Dict,
                        expected_next_fire_at: Optional[str] = None) -> Optional[bool]:
        """PATCH a custom reminder row (synchronous). Never raises.

        Without ``expected_next_fire_at``: True when accepted, False on an HTTP or transport error.
        With it, the PATCH only applies while the row still has that ``next_fire_at`` (a conditional
        update): True when exactly one row changed, None when no row matched (another writer moved
        it first), False on error.
        """
        if not self.is_configured:
            return False
        params = {"id": f"eq.{reminder_id}"}
        prefer = "return=minimal"
        if expected_next_fire_at is not None:
            params["next_fire_at"] = f"eq.{expected_next_fire_at}"
            prefer = "return=representation"
        try:
            r = self._patch("moodle_custom_reminders", params, fields, prefer=prefer)
            if r.status_code not in (200, 204):
                print(f"[Supabase] update_reminder HTTP {r.status_code}: {str(r.text)[:200]}")
                return False
        except Exception as e:
            print(f"[Supabase] update_reminder error: {e}")
            return False
        if expected_next_fire_at is None:
            return True
        try:
            rows = r.json()
        except Exception:  # noqa: BLE001 - an accepted PATCH without a readable body
            return True
        if isinstance(rows, list):
            return True if rows else None
        return True

    # ---- Web Push subscriptions (moodle_push_subscriptions) ------------------------------------------

    def fetch_push_subscriptions(self, user_id: str) -> List[Dict]:
        """The newest ``PUSH_SUBSCRIPTIONS_LIMIT`` Web Push subscriptions of one user.

        Rows carry ``id, endpoint, p256dh, auth, failure_count, created_at, last_success_at,
        last_failure_at``. Returns [] when Supabase is not configured. RAISES on any transport/HTTP
        failure so the caller can tell "no subscriptions" apart from "could not read them".
        """
        if not self.is_configured:
            return []
        params = {
            "user_id": f"eq.{user_id}",
            "select": "id,endpoint,p256dh,auth,failure_count,created_at,last_success_at,last_failure_at",
            "order": "updated_at.desc",
            "limit": str(PUSH_SUBSCRIPTIONS_LIMIT),
        }
        return [row for row in self._get_rows("moodle_push_subscriptions", params) if row.get("endpoint")]

    def fetch_push_test_requests(self) -> List[Dict]:
        """Subscriptions whose owner pressed "Enviar prueba" (``test_requested_at`` set by the web).

        Same contract as ``fetch_push_subscriptions``: [] when unconfigured, RAISES on failure.
        """
        if not self.is_configured:
            return []
        params = {
            "test_requested_at": "not.is.null",
            "select": "id,user_id,endpoint,p256dh,auth,failure_count,test_requested_at",
        }
        return [row for row in self._get_rows("moodle_push_subscriptions", params) if row.get("endpoint")]

    def update_push_subscription(self, sub_id: str, fields: Dict) -> bool:
        """PATCH one subscription row (health fields, ``test_requested_at``). Never raises.

        ``last_failure_reason`` is optional: it is dropped once the server rejected it (see
        ``push_failure_reason_supported``).
        """
        if not self.is_configured:
            return False
        table = "moodle_push_subscriptions"
        try:
            body = self.columns.strip(table, dict(fields or {}))
            r = self._patch(table, {"id": f"eq.{sub_id}"}, body)
            if "last_failure_reason" in body and self.columns.reject(table, r, ("last_failure_reason",)):
                r = self._patch(table, {"id": f"eq.{sub_id}"}, self.columns.strip(table, body))
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] update_push_subscription error: {type(e).__name__}")
            return False

    def clear_push_test_request(self, sub_id: str, requested_at: Optional[str]) -> bool:
        """Clear ``test_requested_at`` only while it still holds ``requested_at`` (the value that was read).

        A newer "Enviar prueba" press made while the test was being sent keeps its flag. True when the
        PATCH was accepted (also when the filter matched no row); never raises.
        """
        if not self.is_configured:
            return False
        params = {"id": f"eq.{sub_id}"}
        if requested_at:
            params["test_requested_at"] = f"eq.{requested_at}"
        try:
            r = self._patch("moodle_push_subscriptions", params, {"test_requested_at": None})
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] clear_push_test_request error: {type(e).__name__}")
            return False

    def delete_push_subscription(self, sub_id: str) -> bool:
        """DELETE one subscription row (the browser unsubscribed or the row kept failing)."""
        if not self.is_configured:
            return False
        try:
            r = self._call("delete", self._endpoint("moodle_push_subscriptions"), params={"id": f"eq.{sub_id}"},
                           headers=self._headers_with("return=minimal"), timeout=10)
            return r.status_code in (200, 204)
        except Exception as e:
            print(f"[Supabase] delete_push_subscription error: {type(e).__name__}")
            return False

    # ---- Notification history (moodle_notification_log) ----------------------------------------------

    def insert_notification_log(self, rows: List[Dict]) -> None:
        """Bulk-insert history rows (all rows must share the same keys; see notification_log.build_row).

        Duplicate-safe: a row whose ``id`` already exists (a retried flush) is skipped, never an error.
        ``push_state`` is optional: once the server rejects it, it is stripped and the insert is
        repeated once. Does nothing when Supabase is not configured or there are no rows. RAISES
        RuntimeError (``HTTP <status>: <body>``) or the transport error so the caller can keep the
        rows for a retry.
        """
        if not self.is_configured or not rows:
            return
        table = "moodle_notification_log"
        url = self._endpoint(f"{table}?on_conflict=id")
        headers = self._headers_with(_MILESTONES_PREFER)
        payload = [self.columns.strip(table, row) for row in rows]
        r = self._call("post", url, json=payload, headers=headers, timeout=_BULK_TIMEOUT)
        if not _ok(r) and any("push_state" in row for row in payload) and self.columns.reject(table, r, ("push_state",)):
            payload = [self.columns.strip(table, row) for row in payload]
            r = self._call("post", url, json=payload, headers=headers, timeout=_BULK_TIMEOUT)
        if not _ok(r):
            raise RuntimeError(f"HTTP {getattr(r, 'status_code', 0)}: {_body(r)}")

    def prune_notification_log(self, cutoff_iso: str) -> None:
        """Delete history rows created before ``cutoff_iso`` (UTC, ``YYYY-MM-DDTHH:MM:SSZ``).

        Same contract as ``insert_notification_log``: no-op when unconfigured, RAISES on failure.
        """
        if not self.is_configured:
            return
        r = self._call(
            "delete",
            self._endpoint("moodle_notification_log"),
            params={"created_at": f"lt.{cutoff_iso}"},
            headers=self._headers_with("return=minimal"),
            timeout=10,
        )
        if not _ok(r):
            raise RuntimeError(f"HTTP {getattr(r, 'status_code', 0)}: {_body(r)}")
