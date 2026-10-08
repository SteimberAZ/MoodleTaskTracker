"""Moodle mobile web-service (REST) client.

Authenticates with a user token (``wstoken``) instead of a browser session cookie.
All functions return plain dicts shaped like the ones produced by the desktop ``MoodleClient`` so
that ``Storage`` and ``TaskNotificationManager`` work unchanged.

Politeness: every client shares one ``requests.Session`` (keep-alive, an identifying User-Agent),
uses split connect/read timeouts, and stops reading assignment statuses after a couple of
consecutive network failures instead of hammering an unreachable site. The course sweep batches
all enrolled courses into one call per function and reuses its result for ``SWEEP_TTL_SECONDS``.
The grade fetch reads one grade report per current course at most once per ``SWEEP_TTL_SECONDS``,
reusing the sweep's course list.
"""
import hashlib
import html
import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional

import requests
from bs4 import BeautifulSoup

DEFAULT_MOODLE_URL = "https://evirtual.utm.edu.ec"

USER_AGENT = "mineral-tareas-worker/1.0"

# (connect, read) seconds: an unreachable host fails fast, a slow but alive one gets time to answer.
DEFAULT_TIMEOUT = (5, 15)

# Calendar events are read from this many days in the past, so overdue tasks stay visible. Matches
# the web "Atrasadas" tab.
OVERDUE_WINDOW_DAYS = 7

# Consecutive network failures while reading assignment statuses before the rest are skipped.
STATUS_NETWORK_ERROR_LIMIT = 2

_SESSION: Optional[requests.Session] = None

# Ecuador has no DST; used only to render the human-readable due date.
_LOCAL_TZ = timezone(timedelta(hours=-5))

# Error codes that mean the token itself is no longer usable.
TOKEN_ERROR_CODES = frozenset({"invalidtoken", "accessexception"})

_CMID_RE = re.compile(r"[?&]id=(\d+)")

# (base_url, course module id) -> assign instance id, shared by every client for the process.
_ASSIGN_INSTANCE_CACHE: Dict[tuple, int] = {}

# Max characters of a Moodle error message written to the logs.
_LOG_MSG_MAX = 200

# Max characters of a task description kept (plain text).
DESCRIPTION_MAX = 4000

# (base_url, course id) -> (expires_at, teacher names). Shared by every client for the process, so
# a sync round makes at most one core_course_get_courses_by_field call per course.
_TEACHERS_CACHE: Dict[tuple, tuple] = {}
TEACHERS_TTL = 12 * 3600  # successful lookups
TEACHERS_ERROR_TTL = 300  # failed lookups are retried after a short pause, not on every user

# Course sweep (assignments/quizzes of every enrolled course, beyond the timeline). One sweep per user per
# task round: rounds start every 30 minutes, the 25-minute TTL leaves room for jitter while the immediate
# post-login sync reuses the cached result.
SWEEP_TTL_SECONDS = 25 * 60
SWEEP_STALE_MAX_SECONDS = 6 * 3600  # a failed sweep reuses the last good result up to this age
SWEEP_MAX_COURSES = 30
SWEEP_STATUS_MAX_CHECKS = 20  # submission/attempt reads per sweep; the least recently read tasks go first
SWEEP_COURSE_MAX_AGE_DAYS = 180  # courses without end date older than this (by startdate) are skipped
# (base_url, user_id) -> {"at": float, "tasks": [task dicts], "complete": bool,
#                         "reads": {cmid: (last attempt time, last known status)}}
_SWEEP_CACHE: Dict[tuple, Dict] = {}
# (base_url, user_id) -> (time read, current enrolled courses, ids of every enrolled course). Written by every
# enrolled-course read, so the grade fetch reuses the course list the course sweep just read instead of asking
# Moodle again. The full id list lets the grade sync keep the grades of finished (no longer current) courses.
_COURSES_CACHE: Dict[tuple, tuple] = {}
# (base_url, user_id) -> time of the last grade fetch attempt (successful or not): at most one per SWEEP_TTL_SECONDS.
_GRADES_CACHE: Dict[tuple, float] = {}
# Grade report item types that are stored (outcomes and anything unknown are skipped).
GRADE_ITEM_TYPES = ("course", "category", "mod", "manual")


def _now() -> float:
    return time.time()


class MoodleApiError(Exception):
    """A Moodle web-service call failed."""

    is_network = False  # True when Moodle could not be reached (timeout, connection, HTTP 5xx)

    def __init__(self, message: str, code: str = "", status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status


class MoodleTokenInvalid(MoodleApiError):
    """The token was rejected (expired, revoked or lacking access)."""


class MoodleNetworkError(MoodleApiError):
    """Moodle was unreachable or failed on its side: a timeout, a connection error or an HTTP 5xx."""

    is_network = True


def shared_session() -> requests.Session:
    """The process-wide HTTP session used by every client that is not given its own ``http``."""
    global _SESSION
    if _SESSION is None:
        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT
        _SESSION = session
    return _SESSION


def _raise_if_error(payload: Any):
    """Moodle reports errors as HTTP 200 with an exception object in the JSON body."""
    if isinstance(payload, dict) and ("exception" in payload or "errorcode" in payload):
        code = str(payload.get("errorcode") or "")
        message = str(payload.get("message") or payload.get("exception") or code or "Moodle error")
        cls = MoodleTokenInvalid if code in TOKEN_ERROR_CODES else MoodleApiError
        raise cls(message, code=code)


class MoodleApiClient:
    """Thin wrapper around ``/webservice/rest/server.php``."""

    def __init__(self, base_url: str, token: str, http: Any = None, timeout: Any = DEFAULT_TIMEOUT,
                 user_id: Optional[str] = None, site_userid: Optional[int] = None):
        self.base_url = (base_url or DEFAULT_MOODLE_URL).rstrip("/")
        self.token = (token or "").strip()
        self.user_id = str(user_id) if user_id else None  # owner of the produced task dicts
        # Moodle user id of the token owner; read from core_webservice_get_site_info when not given.
        self.site_userid = int(site_userid) if str(site_userid or "").isdigit() else None
        self.http = http if http is not None else shared_session()
        self.timeout = timeout
        # False until a fetch_events call read every page (a truncated or failed fetch stays False).
        self.last_fetch_complete = False
        # False when fetch_tasks stopped reading assignment statuses after repeated network errors.
        self.last_status_checks_complete = True
        # False until a sweep result coming from a fully successful sweep is used.
        self.last_sweep_complete = False
        self.enrolled_course_ids: List[int] = []

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
            # The exception text can echo the request URL; only its type is kept.
            raise MoodleNetworkError(f"Network error: {type(e).__name__}", code="network") from e
        if resp.status_code >= 500:
            raise MoodleNetworkError(f"HTTP {resp.status_code}", code="http", status=resp.status_code)
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
        """Action events (due assignments, quizzes, ...) sorted by time, from ``OVERDUE_WINDOW_DAYS`` ago.

        Sets ``last_fetch_complete``: False when ``max_pages`` full pages were read and more may
        exist (or the call failed), so callers never treat a truncated list as the whole picture.
        """
        timesortfrom = int((now if now is not None else time.time()) - OVERDUE_WINDOW_DAYS * 86400)
        self.last_fetch_complete = False
        events: List[Dict] = []
        after: Optional[int] = None
        complete = False
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
                complete = True
                break
            after = last_id
        self.last_fetch_complete = complete
        return events

    def resolve_assign_instance(self, cmid: int) -> Optional[int]:
        """Real ``assign`` instance id of a course module, or None when it cannot be resolved.

        Calendar events do not always carry the assign instance Moodle expects; the course module
        (the ``?id=`` of the activity URL) is authoritative. Results are cached for the process.
        """
        key = (self.base_url, int(cmid))
        if key in _ASSIGN_INSTANCE_CACHE:
            return _ASSIGN_INSTANCE_CACHE[key]
        try:
            payload = self.call("core_course_get_course_module", cmid=int(cmid))
        except MoodleApiError as e:
            if e.code == "invalidtoken":
                raise
            print(f"[MoodleApi] could not resolve course module {cmid}: {e.code}: {str(e)[:_LOG_MSG_MAX]}")
            return None
        cm = payload.get("cm") if isinstance(payload, dict) else None
        if not isinstance(cm, dict) or str(cm.get("modname") or "").lower() != "assign" or not cm.get("instance"):
            print(f"[MoodleApi] course module {cmid} is not a resolvable assign")
            return None
        instance = int(cm["instance"])
        _ASSIGN_INSTANCE_CACHE[key] = instance
        return instance

    def _assign_status(self, assign_id: Optional[int], cmid: Optional[int] = None):
        """(status, assign_id actually used). Falls back to the course module on ``invalidrecord``."""
        if cmid:
            cached = _ASSIGN_INSTANCE_CACHE.get((self.base_url, int(cmid)))
            if cached:
                assign_id = cached
            elif not assign_id:
                assign_id = self.resolve_assign_instance(cmid)
        if not assign_id:
            return None, None
        try:
            payload = self.call("mod_assign_get_submission_status", assignid=assign_id)
            return parse_assign_submission_status(payload), assign_id
        except MoodleApiError as e:
            if e.code != "invalidrecord" or not cmid:
                raise
            instance = self.resolve_assign_instance(cmid)
            if not instance or instance == assign_id:
                raise
            print(f"[MoodleApi] assign {assign_id} is invalid; retrying with instance {instance} of module {cmid}")
        payload = self.call("mod_assign_get_submission_status", assignid=instance)
        return parse_assign_submission_status(payload), instance

    def fetch_assign_status(self, assign_id: Optional[int], course_module_id: Optional[int] = None) -> Optional[str]:
        return self._assign_status(assign_id, course_module_id)[0]

    def fetch_course_teachers(self, course_id: Optional[int]) -> List[str]:
        """Names of the course contacts (teachers), cached per (site, course) for ~12 hours.

        Never raises: any failure is logged once and yields ``[]`` (or the last known list when a
        stale cache entry exists), so task details can never break a sync.
        """
        if not course_id:
            return []
        key = (self.base_url, int(course_id))
        entry = _TEACHERS_CACHE.get(key)
        if entry and entry[0] > _now():
            return list(entry[1])
        try:
            payload = self.call("core_course_get_courses_by_field", field="id", value=int(course_id))
            courses = payload.get("courses") if isinstance(payload, dict) else None
            contacts = courses[0].get("contacts") if courses and isinstance(courses[0], dict) else None
            names: List[str] = []
            for c in contacts or []:
                name = " ".join(str((c or {}).get("fullname") or "").split()) if isinstance(c, dict) else ""
                if name and name not in names:
                    names.append(name)
        except Exception as e:  # noqa: BLE001 - details are optional
            code = getattr(e, "code", "") or type(e).__name__
            print(f"[MoodleApi] could not read teachers of course {course_id}: {code}: {str(e)[:_LOG_MSG_MAX]}")
            stale = list(entry[1]) if entry else []
            _TEACHERS_CACHE[key] = (_now() + TEACHERS_ERROR_TTL, stale)
            return stale
        _TEACHERS_CACHE[key] = (_now() + TEACHERS_TTL, names)
        return list(names)

    def _attach_details(self, tasks: List[Dict]) -> None:
        """Add teachers and the details timestamp to every task fetched from the API."""
        stamp = datetime.now(timezone.utc).isoformat()
        for task in tasks:
            task["teachers"] = self.fetch_course_teachers(task.get("course_id"))
            task["details_updated_at"] = stamp

    def fetch_tasks(self, now: Optional[float] = None, delay: float = 0.2, sweep: bool = True) -> List[Dict]:
        """Fetch events, map them to task dicts and resolve submission status.

        Raises ``MoodleTokenInvalid`` / ``MoodleApiError`` when the events call fails. A failure
        while reading the status of a single assignment only leaves that task as pending, except
        for ``invalidtoken`` which always propagates. After ``STATUS_NETWORK_ERROR_LIMIT``
        consecutive network errors the remaining statuses are not read this round. With ``sweep``
        and a ``user_id`` the course sweep adds the activities the timeline missed;
        ``last_sweep_complete`` tells whether that sweep was fully read.
        """
        tasks = []
        for ev in self.fetch_events(now=now):
            task = event_to_task(ev, self.base_url, user_id=self.user_id)
            if task:
                tasks.append(task)
        self._attach_details(tasks)
        checked = 0
        network_errors = 0
        self.last_status_checks_complete = True
        for task in tasks:
            cmid = task.get("course_module_id")
            is_assign = bool(task.get("assign_id")) or (bool(cmid) and "/mod/assign/" in str(task.get("task_url")))
            if task["status"] == "submitted" or not is_assign:
                continue
            if network_errors >= STATUS_NETWORK_ERROR_LIMIT:
                self.last_status_checks_complete = False
                print(f"[MoodleApi] Moodle unreachable: {network_errors} status reads failed in a row; "
                      "the remaining assignment statuses are skipped this round")
                break
            if checked and delay:
                time.sleep(delay)
            checked += 1
            try:
                detected, used_id = self._assign_status(task.get("assign_id"), cmid)
            except MoodleApiError as e:
                if e.code == "invalidtoken":
                    raise
                network_errors = network_errors + 1 if e.is_network else 0
                ref = task.get("assign_id") or f"cmid {cmid}"
                print(f"[MoodleApi] assign status failed for {ref}: {e.code or 'error'}: {str(e)[:_LOG_MSG_MAX]}")
                continue
            network_errors = 0
            if used_id:
                task["assign_id"] = used_id  # the instance Moodle actually accepted
            if detected:
                task["status"] = detected
                task["status_source"] = "api"
        self.last_sweep_complete = False
        if sweep and self.user_id:
            known = {int(t["course_module_id"]) for t in tasks if t.get("course_module_id")}
            ids = {t["id"] for t in tasks}
            extra = self.sweep_course_activities(now=now, known_cmids=known, delay=delay)
            tasks.extend(t for t in extra if t.get("course_module_id") not in known and t["id"] not in ids)
        return tasks

    # ---- course sweep ------------------------------------------------------------------

    def _site_userid(self) -> int:
        """Moodle user id of the token owner, read once from core_webservice_get_site_info."""
        if self.site_userid is not None:
            return self.site_userid
        payload = self.call("core_webservice_get_site_info")
        try:
            uid = int(payload["userid"])
        except (KeyError, TypeError, ValueError) as e:
            raise MoodleApiError("no userid", code="badresponse") from e
        self.site_userid = uid
        return uid

    def _current_courses(self, now: float, use_cache: bool = False) -> Optional[List[Dict]]:
        """Current enrolled courses, newest first, at most SWEEP_MAX_COURSES; None when Moodle answered something
        that is not a list. May raise (MoodleApiError)."""
        key = (self.base_url, self.user_id)
        entry = _COURSES_CACHE.get(key)
        if use_cache and entry and now - entry[0] < SWEEP_TTL_SECONDS:
            self.enrolled_course_ids = list(entry[2])
            return [dict(c) for c in entry[1]]
        uid = self._site_userid()
        payload = self.call("core_enrol_get_users_courses", userid=uid)
        if not isinstance(payload, list):
            return None
        enrolled = sorted({int(c["id"]) for c in payload if isinstance(c, dict) and str(c.get("id") or "").isdigit()})
        current = [c for c in payload if course_is_current(c, now) and str(c.get("id") or "").isdigit()]
        current.sort(key=lambda c: int(c.get("startdate") or 0), reverse=True)
        current = current[:SWEEP_MAX_COURSES]
        _COURSES_CACHE[key] = (now, [dict(c) for c in current], tuple(enrolled))
        self.enrolled_course_ids = enrolled
        return current

    def _sweep_status(self, task: Dict) -> Optional[str]:
        """'submitted' | 'pending' for a swept assignment or quiz, None when it cannot be read."""
        if task.get("module") == "assign":
            status, used = self._assign_status(task.get("assign_id"), task.get("course_module_id"))
            if used:
                task["assign_id"] = used
            return status
        if task.get("module") == "quiz":
            payload = self.call("mod_quiz_get_user_attempts", quizid=int(task["quiz_id"]), status="finished")
            attempts = payload.get("attempts") if isinstance(payload, dict) else None
            return "submitted" if attempts else "pending"
        return None

    def _fresh_sweep(self, now: float, known_cmids: set, delay: float, reads: Dict[int, tuple]) -> List[Dict]:
        """Read the enrolled courses and their assignments and quizzes. May raise (the caller falls back).

        ``reads`` maps a course module to (time its status was last attempted, last known status). It is
        updated in place: the status budget rotates across rounds, and a task that is not read this round
        keeps the status it had before instead of reverting to pending.
        """
        current = self._current_courses(now) or []
        if not current:
            return []
        by_id = {int(c["id"]): c for c in current}
        params = {f"courseids[{i}]": cid for i, cid in enumerate(by_id)}
        assigns = self.call("mod_assign_get_assignments", **params)
        quizzes = self.call("mod_quiz_get_quizzes_by_courses", **params)

        found: List[Optional[Dict]] = []
        for c in (assigns.get("courses") if isinstance(assigns, dict) else None) or []:
            if not isinstance(c, dict):
                continue
            course = by_id.get(int(c.get("id") or 0)) or c
            for a in c.get("assignments") or []:
                found.append(assignment_to_task(a, course, self.base_url, self.user_id, now))
        for q in (quizzes.get("quizzes") if isinstance(quizzes, dict) else None) or []:
            if not isinstance(q, dict):
                continue
            course = by_id.get(int(q.get("course") or 0)) or {"id": q.get("course")}
            found.append(quiz_to_task(q, course, self.base_url, self.user_id, now))

        tasks: List[Dict] = []
        seen: set = set()
        for task in found:
            if task is None or task["course_module_id"] in known_cmids or task["course_module_id"] in seen:
                continue
            seen.add(task["course_module_id"])
            tasks.append(task)

        for task in tasks:  # tasks the budget does not reach keep the last status Moodle reported
            last_known = reads.get(task["course_module_id"], (0.0, None))[1]
            if last_known:
                task["status"] = last_known
                task["status_source"] = "api"
        # The budget is smaller than a big sweep: read the least recently attempted tasks first (never read
        # counts as oldest), then the soonest due, so every task is reached within a few rounds.
        checked = 0
        network_errors = 0
        for task in sorted(tasks, key=lambda t: (reads.get(t["course_module_id"], (0.0, None))[0],
                                                 t["due_timestamp"] or float("inf"))):
            cmid = task["course_module_id"]
            if checked >= SWEEP_STATUS_MAX_CHECKS or network_errors >= STATUS_NETWORK_ERROR_LIMIT:
                break
            if checked and delay:
                time.sleep(delay)
            checked += 1
            previous = reads.get(cmid, (0.0, None))[1]
            reads[cmid] = (now, previous)  # an attempt counts even when it fails
            try:
                status = self._sweep_status(task)
            except MoodleApiError as e:
                # Not fatal: an 'accessexception' here means this function is not allowed, not a bad token.
                network_errors = network_errors + 1 if e.is_network else 0
                print(f"[MoodleApi] sweep status failed for cmid {cmid}: {e.code or 'error'}")
                continue
            network_errors = 0
            if status:
                reads[cmid] = (now, status)
                task["status"] = status
                task["status_source"] = "api"
        live = {t["course_module_id"] for t in tasks}
        for cmid in [c for c in reads if c not in live]:
            del reads[cmid]  # activities that left the sweep
        self._attach_details(tasks)
        return tasks

    def sweep_course_activities(self, now: Optional[float] = None, known_cmids: Iterable[int] = (),
                                delay: float = 0.2) -> List[Dict]:
        """Assignments and quizzes of the enrolled courses that the timeline did not return. Never raises."""
        now = now if now is not None else _now()
        key = (self.base_url, self.user_id)
        entry = _SWEEP_CACHE.get(key)
        if entry and now - entry["at"] < SWEEP_TTL_SECONDS:
            tasks = entry["tasks"]
            self.last_sweep_complete = entry["complete"]
        else:
            kept_reads = dict((entry or {}).get("reads") or {})
            reads = dict(kept_reads)
            try:
                tasks = self._fresh_sweep(now, set(int(c) for c in known_cmids if c), delay, reads)
                _SWEEP_CACHE[key] = {"at": now, "tasks": tasks, "complete": True, "reads": reads}
                self.last_sweep_complete = True
                print(f"[MoodleApi] course sweep: {len(tasks)} activity(ies) outside the timeline")
            except Exception as e:  # noqa: BLE001 - a sweep failure must never break the sync
                code = getattr(e, "code", "") or type(e).__name__
                print(f"[MoodleApi] course sweep failed ({code}); timeline only this round")
                self.last_sweep_complete = False
                # Keep the last good result for a while; retry after the TTL, not on every sync.
                if entry and now - entry["at"] < SWEEP_STALE_MAX_SECONDS:
                    tasks = entry["tasks"]
                else:
                    tasks = []
                _SWEEP_CACHE[key] = {"at": now, "tasks": tasks, "complete": False, "reads": kept_reads}
        # Copies, so callers mutating the returned dicts never change the cache.
        return [dict(t, teachers=list(t.get("teachers") or [])) for t in tasks]

    # ---- grades ------------------------------------------------------------------------

    def grades_due(self, now: Optional[float] = None) -> bool:
        """Whether a grade fetch may run now: needs a user, and none was attempted within SWEEP_TTL_SECONDS."""
        if not self.user_id:
            return False
        now = now if now is not None else _now()
        last = _GRADES_CACHE.get((self.base_url, self.user_id))
        return last is None or now - last >= SWEEP_TTL_SECONDS

    def fetch_course_grades(self, now: Optional[float] = None, delay: float = 0.2) -> Optional[Dict]:
        """Grade items of every current enrolled course, at most once per SWEEP_TTL_SECONDS per user.

        Never raises. Returns None when not due, when the course list cannot be read, or when the token was
        rejected; otherwise {'courses': [{'id', 'fullname', 'shortname'}], 'items': {course id: [rows of
        parse_grade_items]}, 'failed': [course ids whose grades could not be read], 'complete': bool,
        'enrolled_ids': [ids of every enrolled course, current or finished]}.
        """
        now = now if now is not None else _now()
        if not self.grades_due(now):
            return None
        # Stamped before any call: a failing Moodle is retried after the TTL, not on every sync.
        _GRADES_CACHE[(self.base_url, self.user_id)] = now
        try:
            try:
                uid = self._site_userid()
                courses = self._current_courses(now, use_cache=True)
            except Exception as e:  # noqa: BLE001 - grades are optional
                code = getattr(e, "code", "") or type(e).__name__
                print(f"[MoodleApi] grade fetch skipped: could not read the enrolled courses ({code})")
                return None
            if courses is None:
                print("[MoodleApi] grade fetch skipped: could not read the enrolled courses (badresponse)")
                return None
            items: Dict[int, List[Dict]] = {}
            failed: List[int] = []
            network_errors = 0
            for i, c in enumerate(courses):
                cid = int(c["id"])
                if network_errors >= STATUS_NETWORK_ERROR_LIMIT:
                    failed.append(cid)
                    continue
                if i and delay:
                    time.sleep(delay)
                try:
                    payload = self.call("gradereport_user_get_grade_items", courseid=cid, userid=uid)
                except MoodleApiError as e:
                    if e.code == "invalidtoken":
                        print("[MoodleApi] grade fetch stopped: token rejected")
                        return None
                    # An 'accessexception' means this course's report is not allowed, not a bad token.
                    network_errors = network_errors + 1 if e.is_network else 0
                    print(f"[MoodleApi] grades of course {cid} not read: {e.code or 'error'}")
                    failed.append(cid)
                    continue
                network_errors = 0
                rows = parse_grade_items(payload, c, uid)
                if rows is None:
                    failed.append(cid)
                else:
                    items[cid] = rows
            return {
                "courses": [{"id": int(c["id"]), "fullname": c.get("fullname"), "shortname": c.get("shortname")}
                            for c in courses],
                "items": items,
                "failed": failed,
                "complete": not failed,
                "enrolled_ids": list(getattr(self, "enrolled_course_ids", None) or []),
            }
        except Exception as e:  # noqa: BLE001 - a grade failure must never break the sync
            print(f"[MoodleApi] grade fetch failed ({type(e).__name__})")
            return None


# ---- pure mapping helpers ------------------------------------------------------------------


def _float_or_none(value: Any) -> Optional[float]:
    """A finite float from a number or numeric string, None for anything else (bool, '', NaN, inf)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _int_or_none(value: Any) -> Optional[int]:
    """An int from an int or a digit string, None for anything else (bool included)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def parse_grade_items(payload: Any, course: Dict, site_userid: Optional[int] = None) -> Optional[List[Dict]]:
    """Grade rows from a gradereport_user_get_grade_items response.

    None when the answer is malformed (the caller treats the course as failed). Items hidden from the student
    and unknown item types are never kept, and neither is the feedback text.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("usergrades"), list):
        return None
    entries = [e for e in payload["usergrades"] if isinstance(e, dict)]
    entry = None
    if site_userid is not None:
        entry = next((e for e in entries if _int_or_none(e.get("userid")) == site_userid), None)
    elif entries:
        entry = entries[0]
    if entry is None:
        return []
    report_depth = _int_or_none(entry.get("maxdepth"))
    course_name = str(course.get("fullname") or course.get("shortname") or "Materia no especificada")
    rows: List[Dict] = []
    seen: set = set()
    for i, it in enumerate(entry.get("gradeitems") or []):
        if not isinstance(it, dict):
            continue
        itemtype = it.get("itemtype")
        if itemtype not in GRADE_ITEM_TYPES:
            continue
        item_id = _int_or_none(it.get("id"))
        if item_id is None or item_id in seen:
            continue
        if it.get("gradeishidden") or it.get("gradehiddenbydate") or it.get("hidden"):
            continue  # grades hidden from the student are never stored
        seen.add(item_id)
        rows.append({
            "course_id": int(course["id"]),
            "item_id": item_id,
            "course_name": course_name,
            "item_name": html.unescape(str(it.get("itemname") or "")).strip() or None,
            "item_type": itemtype,
            "item_module": str(it.get("itemmodule") or "") or None,
            "cmid": _int_or_none(it.get("cmid")),
            "item_instance": _int_or_none(it.get("iteminstance")),
            "category_id": _int_or_none(it.get("categoryid")),
            "sort_order": i,
            "report_depth": report_depth,
            "grade_raw": _float_or_none(it.get("graderaw")),
            "grade_min": _float_or_none(it.get("grademin")),
            "grade_max": _float_or_none(it.get("grademax")),
            "grade_formatted": str(it.get("gradeformatted") or "") or None,
            "percentage_formatted": str(it.get("percentageformatted") or "") or None,
            "weight_raw": _float_or_none(it.get("weightraw")),
            "graded_at": _int_or_none(it.get("gradedategraded")) or None,
        })
    return rows


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


def html_to_text(raw: Any, limit: int = DESCRIPTION_MAX) -> str:
    """Plain text of an HTML fragment: tags stripped, entities unescaped, whitespace collapsed."""
    if not raw:
        return ""
    soup = BeautifulSoup(str(raw), "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    text = html.unescape(soup.get_text(" "))
    text = " ".join(text.replace(" ", " ").split())
    return text[:limit]


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
        "module": module or None,
        "course_id": int(course["id"]) if str(course.get("id") or "").isdigit() else None,
        "description": html_to_text(ev.get("description")),
    }
    if user_id:
        task["user_id"] = str(user_id)
    return task


def activity_url(base_url: str, module: str, cmid: int) -> str:
    """The activity URL the calendar timeline uses, so swept tasks keep the timeline task id."""
    return f"{base_url.rstrip('/')}/mod/{module}/view.php?id={int(cmid)}"


def course_is_current(course: Dict, now: float) -> bool:
    """Whether a core_enrol_get_users_courses entry is worth sweeping: visible, not completed, recent."""
    if not isinstance(course, dict):
        return False
    if course.get("visible") is not None and int(course["visible"]) == 0:
        return False
    if course.get("completed"):
        return False
    enddate = int(course.get("enddate") or 0)
    if enddate > 0:
        return enddate >= now - OVERDUE_WINDOW_DAYS * 86400
    startdate = int(course.get("startdate") or 0)
    return startdate == 0 or startdate >= now - SWEEP_COURSE_MAX_AGE_DAYS * 86400


def _swept_task(module: str, cmid: int, name: Any, due: int, course: Dict, intro: Any, base_url: str,
                user_id: Optional[str], assign_id: Optional[int] = None, quiz_id: Optional[int] = None) -> Dict:
    """Task dict for an activity found by the course sweep: the event_to_task shape, the same task id."""
    url = activity_url(base_url, module, cmid)
    task = {
        "id": make_task_id(url, user_id),
        "title": str(name or "").strip() or "Sin título",
        "course": course.get("fullname") or course.get("shortname") or "Materia no especificada",
        "due_date_str": _format_due(int(due)),
        "due_timestamp": int(due),
        "task_url": url,
        "status": "pending",
        "assign_id": assign_id,
        "course_module_id": int(cmid),
        "event_id": None,
        "module": module,
        "course_id": int(course["id"]) if str(course.get("id") or "").isdigit() else None,
        "description": html_to_text(intro),
        "source": "sweep",
        "quiz_id": quiz_id,
    }
    if user_id:
        task["user_id"] = str(user_id)
    return task


def assignment_to_task(a: Dict, course: Dict, base_url: str, user_id: Optional[str], now: float) -> Optional[Dict]:
    """Task for an assignment the timeline did not return, or None when there is nothing to hand in."""
    if not isinstance(a, dict) or int(a.get("cmid") or 0) <= 0 or not a.get("id"):
        return None
    due = int(a.get("duedate") or 0) or int(a.get("cutoffdate") or 0)
    if due and due < now - OVERDUE_WINDOW_DAYS * 86400:
        return None  # same overdue window as the timeline
    if not due and int(a.get("nosubmissions") or 0) == 1:
        return None  # offline assignment without a date: nothing to hand in
    return _swept_task("assign", a["cmid"], a.get("name"), due, course, a.get("intro"), base_url, user_id,
                       assign_id=int(a["id"]))


def quiz_to_task(q: Dict, course: Dict, base_url: str, user_id: Optional[str], now: float) -> Optional[Dict]:
    """Task for a quiz the timeline did not return, or None when it is closed or not a course module."""
    if not isinstance(q, dict) or int(q.get("coursemodule") or 0) <= 0 or not q.get("id"):
        return None
    due = int(q.get("timeclose") or 0)
    if due and due < now:
        return None  # closed: an attempt cannot be told apart here; the timeline covers recent ones
    return _swept_task("quiz", q["coursemodule"], q.get("name"), due, course, q.get("intro"), base_url, user_id,
                       quiz_id=int(q["id"]))


# ---- token source ----------------------------------------------------------------------------


class Credentials:
    def __init__(self, token: str, base_url: str, source: str):
        self.token = token
        self.base_url = base_url
        self.source = source  # 'user' (moodle_users row) | 'supabase' | 'env'

    @property
    def fingerprint(self) -> str:
        """Non-reversible short id of the token (safe to store and log)."""
        return hashlib.sha256(self.token.encode("utf-8")).hexdigest()[:12]

