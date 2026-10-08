"""Moodle mobile web-service (REST) client.

Authenticates with a user token (``wstoken``) instead of a browser session cookie.
All functions return plain dicts shaped like the ones produced by ``MoodleClient`` so that
``Storage`` and ``TaskNotificationManager`` work unchanged.
"""
import hashlib
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

import requests

DEFAULT_MOODLE_URL = "https://evirtual.utm.edu.ec"

# Ecuador has no DST; used only to render the human-readable due date.
_LOCAL_TZ = timezone(timedelta(hours=-5))

# Error codes that mean the token itself is no longer usable.
TOKEN_ERROR_CODES = frozenset({"invalidtoken", "accessexception"})

_CMID_RE = re.compile(r"[?&]id=(\d+)")


class MoodleApiError(Exception):
    """A Moodle web-service call failed."""

    def __init__(self, message: str, code: str = "", status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status


class MoodleTokenInvalid(MoodleApiError):
    """The token was rejected (expired, revoked or lacking access)."""


def _raise_if_error(payload: Any):
    """Moodle reports errors as HTTP 200 with an exception object in the JSON body."""
    if isinstance(payload, dict) and ("exception" in payload or "errorcode" in payload):
        code = str(payload.get("errorcode") or "")
        message = str(payload.get("message") or payload.get("exception") or code or "Moodle error")
        cls = MoodleTokenInvalid if code in TOKEN_ERROR_CODES else MoodleApiError
        raise cls(message, code=code)


class MoodleApiClient:
    """Thin wrapper around ``/webservice/rest/server.php``."""

    def __init__(self, base_url: str, token: str, http: Any = None, timeout: int = 20, user_id: Optional[str] = None):
        self.base_url = (base_url or DEFAULT_MOODLE_URL).rstrip("/")
        self.token = (token or "").strip()
        self.user_id = str(user_id) if user_id else None  # owner of the produced task dicts
        self.http = http if http is not None else requests
        self.timeout = timeout

    @property
    def endpoint(self) -> str:
        return f"{self.base_url}/webservice/rest/server.php"

    def call(self, wsfunction: str, **params) -> Any:
        data = {
            "wstoken": self.token,
            "wsfunction": wsfunction,
            "moodlewsrestformat": "json",
        }
        data.update({k: v for k, v in params.items() if v is not None})
        try:
            resp = self.http.post(self.endpoint, data=data, timeout=self.timeout)
        except requests.exceptions.RequestException as e:
            raise MoodleApiError(f"Network error: {e}", code="network") from e
        if resp.status_code != 200:
            raise MoodleApiError(f"HTTP {resp.status_code}", code="http", status=resp.status_code)
        try:
            payload = resp.json()
        except ValueError as e:
            raise MoodleApiError("Response is not valid JSON", code="badresponse") from e
        _raise_if_error(payload)
        return payload

    # ---- tasks -------------------------------------------------------------------------

    def fetch_events(self, now: Optional[float] = None, limit: int = 50, max_pages: int = 5) -> List[Dict]:
        """Action events (due assignments, quizzes, ...) sorted by time, from 1 day ago."""
        timesortfrom = int((now if now is not None else time.time()) - 86400)
        events: List[Dict] = []
        after: Optional[int] = None
        for _ in range(max_pages):
            payload = self.call(
                "core_calendar_get_action_events_by_timesort",
                timesortfrom=timesortfrom,
                limitnum=limit,
                aftereventid=after,
            )
            page = payload.get("events", []) if isinstance(payload, dict) else []
            events.extend(page)
            last_id = payload.get("lastid") if isinstance(payload, dict) else None
            if len(page) < limit or not last_id:
                break
            after = last_id
        return events

    def fetch_assign_status(self, assign_id: int) -> Optional[str]:
        payload = self.call("mod_assign_get_submission_status", assignid=assign_id)
        return parse_assign_submission_status(payload)

    def fetch_tasks(self, now: Optional[float] = None, delay: float = 0.2) -> List[Dict]:
        """Fetch events, map them to task dicts and resolve submission status.

        Raises ``MoodleTokenInvalid`` / ``MoodleApiError`` when the events call fails. A failure
        while reading the status of a single assignment only leaves that task as pending, except
        for ``invalidtoken`` which always propagates.
        """
        tasks = []
        for ev in self.fetch_events(now=now):
            task = event_to_task(ev, self.base_url, user_id=self.user_id)
            if task:
                tasks.append(task)
        checked = 0
        for task in tasks:
            if task["status"] == "submitted" or not task.get("assign_id"):
                continue
            if checked and delay:
                time.sleep(delay)
            checked += 1
            try:
                detected = self.fetch_assign_status(task["assign_id"])
            except MoodleApiError as e:
                if e.code == "invalidtoken":
                    raise
                print(f"[MoodleApi] assign status failed for {task['assign_id']}: {e.code or e}")
                continue
            if detected:
                task["status"] = detected
                task["status_source"] = "api"
        return tasks


# ---- pure mapping helpers ------------------------------------------------------------------


def parse_assign_submission_status(payload: Any) -> Optional[str]:
    """'submitted' | 'pending' | None from a mod_assign_get_submission_status response."""
    if not isinstance(payload, dict):
        return None
    last = payload.get("lastattempt")
    if not isinstance(last, dict):
        return None
    statuses = []
    for key in ("submission", "teamsubmission"):
        sub = last.get(key)
        if isinstance(sub, dict) and sub.get("status"):
            statuses.append(str(sub["status"]).lower())
    if "submitted" in statuses:
        return "submitted"
    if statuses:
        return "pending"  # draft / new / reopened
    return None


def _format_due(ts: int) -> str:
    if not ts:
        return "Sin fecha límite indicada"
    return datetime.fromtimestamp(ts, _LOCAL_TZ).strftime("%d/%m/%Y %H:%M")


def make_task_id(url: str, user_id: Optional[str] = None) -> str:
    """Task id: md5 of the activity URL, namespaced by owner in multi-user mode.

    Without ``user_id`` this is the legacy single-user scheme (md5 of the URL). With it the id is
    md5("<user_id>:<url>"), so two users enrolled in the same course get distinct rows.
    """
    raw = f"{user_id}:{url}" if user_id else url
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def event_to_task(ev: Dict, base_url: str = "", user_id: Optional[str] = None) -> Optional[Dict]:
    """Map a calendar action event to the task dict used by Storage/Notifier.

    With ``user_id`` the task id is namespaced by owner and the dict carries ``user_id``.
    """
    if not isinstance(ev, dict):
        return None
    module = str(ev.get("modulename") or "").lower()
    name = str(ev.get("name") or "").strip()
    if module == "attendance" or "asistencia" in name.lower() or "attendance" in name.lower():
        return None

    url = str(ev.get("url") or (ev.get("action") or {}).get("url") or "")
    if not url:
        url = f"{base_url.rstrip('/')}/calendar/view.php"
    ts = int(ev.get("timesort") or ev.get("timestart") or 0)

    # Legacy scheme matches the cookie scraper (md5 of the activity URL); see make_task_id.
    task_id = make_task_id(url, user_id)

    cmid = None
    m = _CMID_RE.search(url)
    if m and "/mod/" in url:
        cmid = int(m.group(1))

    course = ev.get("course") or {}
    action = ev.get("action") or {}
    status = "pending"
    if module != "assign" and action.get("actionable") is False:
        status = "submitted"

    assign_id = None
    if module == "assign" and ev.get("instance"):
        assign_id = int(ev["instance"])

    task = {
        "id": task_id,
        "title": name or "Sin título",
        "course": course.get("fullname") or course.get("shortname") or "Materia no especificada",
        "due_date_str": _format_due(ts),
        "due_timestamp": ts,
        "task_url": url,
        "status": status,
        "assign_id": assign_id,
        "course_module_id": cmid,
        "event_id": ev.get("id"),
    }
    if user_id:
        task["user_id"] = str(user_id)
    return task


# ---- token source ----------------------------------------------------------------------------


class Credentials:
    def __init__(self, token: str, base_url: str, source: str):
        self.token = token
        self.base_url = base_url
        self.source = source  # 'supabase' | 'env'

    @property
    def fingerprint(self) -> str:
        """Non-reversible short id of the token (safe to store and log)."""
        return hashlib.sha256(self.token.encode("utf-8")).hexdigest()[:12]


def resolve_credentials(supabase: Any = None, env: Optional[Dict[str, str]] = None) -> Optional[Credentials]:
    """Token from Supabase ``moodle_credentials`` (id=1), falling back to env ``MOODLE_TOKEN``."""
    env = os.environ if env is None else env
    default_url = (env.get("MOODLE_URL") or DEFAULT_MOODLE_URL).strip()
    row = None
    if supabase is not None and getattr(supabase, "is_configured", False):
        try:
            row = supabase.fetch_credentials()
        except Exception as e:
            print(f"[MoodleApi] could not read moodle_credentials: {e}")
    if row and str(row.get("token") or "").strip():
        return Credentials(str(row["token"]).strip(), str(row.get("moodle_url") or default_url), "supabase")
    token = (env.get("MOODLE_TOKEN") or "").strip()
    if token:
        return Credentials(token, default_url, "env")
    return None
