"""Task synchronisation through the Moodle web service (token based).

``sync_tasks_via_api`` never raises: it returns ``"ok"``, ``"invalid"`` (token rejected) or
``"error"`` (transient failure) so the worker loop can decide what to do next.

Two modes share one implementation:
  * single-user (no ``user``): ``creds`` only, alerts to the env ntfy topic (desktop app and tests;
    the worker always passes ``user``);
  * multi-user (``user=`` row from ``moodle_users``): per-user task ids, first-sync guard and
    token-alert dedup state, errors recorded on the user row, notifications to the user's topic or,
    when the worker passes ``deliver`` (delivery.deliver_to_user), to every channel of the user
    (Web Push first, ntfy optional).

Multi-user robustness:
  * a ``CircuitBreaker`` shared by one round counts consecutive network failures across users, so
    the worker stops calling an unreachable Moodle after a few of them;
  * a user whose token was rejected and who has not logged in since is not sent to Moodle again;
    their cached tasks still get the 1d/8h alerts, marked as unverified;
  * after a complete fetch, tasks that vanished from the calendar are reconciled: a vanished
    assignment that was submitted becomes submitted, the rest are flagged missing remotely after
    ``MISSING_ROUNDS`` consecutive absent rounds.
"""
import json
import re
import time
from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable, Dict, List, Optional

from moodle_api import (
    OVERDUE_WINDOW_DAYS,
    TOKEN_ERROR_CODES,
    Credentials,
    MoodleApiClient,
    MoodleApiError,
    MoodleTokenInvalid,
)
from notifier import TaskNotificationManager, send_system_alert

MIGRATION_FLAG = "api_migration_done"
ALERT_SETTING = "api_token_alert_fingerprint"
MISSING_SETTING = "reconcile_missing"

DISCONNECTED_TITLE = "Moodle desconectado"
DISCONNECTED_MESSAGE = "Moodle desconectado: vuelve a conectar tu cuenta en la web"
USER_DISCONNECTED_MESSAGE = "Moodle desconectado: vuelve a iniciar sesión en la web"
# Appended to task alerts built from the local cache while the user's token is rejected.
CACHED_STATUS_NOTE = "Moodle desconectado: estado de entrega sin verificar, vuelve a iniciar sesión"

# Consecutive network failures (across users) after which the rest of a round is skipped.
BREAKER_THRESHOLD = 3
# Consecutive complete rounds a task must be absent before it is flagged missing remotely.
MISSING_ROUNDS = 2
# Politeness bounds of the reconciliation status re-checks, per user and round.
RECONCILE_MAX_CHECKS = 10
RECONCILE_DELAY = 0.2

_CMID_RE = re.compile(r"[?&]id=(\d+)")

# user id -> {task id: task dict of the latest fetch}. Lets reconciliation keep the details of a task
# that vanished from the calendar when it is re-saved as submitted.
_LAST_FETCHED: Dict[str, Dict[str, Dict]] = {}


class CircuitBreaker:
    """Counts consecutive Moodle network failures across the users of one round.

    ``tripped`` once ``threshold`` failures happened in a row; any answer from Moodle (including a
    rejected token) resets the streak.
    """

    def __init__(self, threshold: int = BREAKER_THRESHOLD):
        self.threshold = threshold
        self.failures = 0

    @property
    def tripped(self) -> bool:
        return self.failures >= self.threshold

    def record_network_error(self) -> None:
        self.failures += 1

    def record_reachable(self) -> None:
        self.failures = 0


def migration_flag_key(user_id: Optional[str] = None) -> str:
    """Local-settings key of the first-sync guard (one per user in multi-user mode)."""
    return f"{MIGRATION_FLAG}:{user_id}" if user_id else MIGRATION_FLAG


def alert_setting_key(user_id: Optional[str] = None) -> str:
    """Local-settings key holding the fingerprint of the token an alert was already sent for."""
    return f"{ALERT_SETTING}:{user_id}" if user_id else ALERT_SETTING


def missing_setting_key(user_id: str) -> str:
    """Local-settings key of the per-user {task id: consecutive absent rounds} counters."""
    return f"{MISSING_SETTING}:{user_id}"


def apply_migration_guard(storage, tasks: List[Dict], user_id: Optional[str] = None) -> bool:
    """One-time guard for the first API-based sync (per user in multi-user mode).

    Task ids from the API may not match the ids stored earlier, and a newly registered user has a
    backlog of existing tasks. To avoid a burst of "new task" alerts for tasks the user already
    knows, pre-record the ``new`` milestone for every fetched task. Returns True when the guard
    ran (so the caller can treat nothing as new).
    """
    flag = migration_flag_key(user_id)
    if storage.get_setting(flag, "") == "1":
        return False
    for t in tasks:
        storage.record_milestone(str(t["id"]), "new")
    storage.set_setting(flag, "1")
    return True


def _parse_ts(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def token_rejected_since_login(user: Dict) -> bool:
    """True when the user's token was rejected and they have not logged in since.

    ``last_error`` starts with the Moodle error code (``invalidtoken: ...``). A login refreshes the
    token, so ``last_login_at`` after ``last_error_at`` re-enables the user. Missing or unreadable
    timestamps never skip anyone.
    """
    code = str(user.get("last_error") or "").split(":", 1)[0].strip().lower()
    if code not in TOKEN_ERROR_CODES:
        return False
    error_at, login_at = _parse_ts(user.get("last_error_at")), _parse_ts(user.get("last_login_at"))
    if error_at is None or login_at is None:
        return False
    return login_at <= error_at


def _report_error(supabase: Any, creds: Credentials, message: Optional[str], user: Optional[Dict] = None):
    fields = {"last_error": message, "last_error_at": datetime.now(timezone.utc).isoformat() if message else None}
    if user is not None:
        if supabase is None:
            return
        try:
            supabase.update_user(user["id"], fields)
        except Exception as e:
            print(f"[ApiSync] could not update moodle_users: {e}")
        return
    if creds.source != "supabase" or supabase is None:
        return
    try:
        supabase.update_credentials(fields)
    except Exception as e:
        print(f"[ApiSync] could not update moodle_credentials: {e}")


def _apply_web_mutes(storage, supabase: Any, user_id: str, tasks: List[Dict], label: str) -> bool:
    """Mark the tasks this user muted on the web as dismissed (in memory and in local SQLite).

    Supabase is the source of truth for ``is_dismissed``. Returns False when the mutes could not be
    read: the caller must then skip notifications for this user so muted tasks are not spammed.
    Without a configured Supabase there is no web to mute from, so notifications proceed.
    """
    fetch = getattr(supabase, "fetch_muted_task_ids", None)
    if not fetch or not getattr(supabase, "is_configured", False):
        return True
    try:
        muted = {str(i) for i in fetch(user_id)}
    except Exception as e:
        print(f"{label} could not read muted tasks: {e}")
        return False
    for t in tasks:
        t["is_dismissed"] = 1 if str(t["id"]) in muted else 0
    storage.apply_dismissed(user_id, muted)
    if muted:
        print(f"{label} {len(muted)} task(s) muted from the web.")
    return True


def _user_alert(deliver: Callable, user: Dict) -> Callable:
    """An ``alert`` callable (the ``send_system_alert`` keywords) that reaches every channel of ``user``."""

    def alert(title, message, priority="default", tags="", topic=None, click_url="", **_unused):
        return deliver(
            user, title, message, url="/", tag="moodle-status", priority=priority, ntfy_tags=tags or "bell",
            kind="status",
        )

    return alert


def _alert_disconnected(storage, alert: Callable, alert_key: str, creds: Credentials, user: Optional[Dict],
                        route: Dict[str, Any]) -> None:
    """Send "Moodle desconectado" once per token; an undelivered alert is retried on the next sync."""
    if storage.get_setting(alert_key, "") == creds.fingerprint:
        return
    sent = alert(
        title=DISCONNECTED_TITLE,
        message=USER_DISCONNECTED_MESSAGE if user else DISCONNECTED_MESSAGE,
        priority="urgent",
        tags="warning,rotating_light",
        **route,
    )
    if sent is not False:  # False = no channel got through: leave it unrecorded, retry next sync
        storage.set_setting(alert_key, creds.fingerprint)


def _notify_cached_tasks(storage, user: Optional[Dict], deliver: Optional[Callable], process: Callable,
                         route: Dict[str, Any], label: str) -> None:
    """Time-based alerts (3d/2d/1d/8h) from the local copy of the user's tasks while Moodle rejects them.

    The submission status cannot be verified, so every alert carries ``CACHED_STATUS_NOTE``. The
    milestones dedupe repeats across rounds; no "new" alerts come from the cache. Never raises.
    """
    if not user or deliver is None:
        return
    try:
        cached = [t for t in storage.get_all_tasks(user_id=str(user["id"])) if t.get("status") != "submitted"]
        if not cached:
            return

        def noted(title, body, **kwargs):
            return deliver(user, title, f"{body}\n{CACHED_STATUS_NOTE}", **kwargs)

        process(cached, storage, new_tasks=None, topic=route.get("topic"), desktop=False, deliver=noted)
    except Exception as e:  # noqa: BLE001 - the disconnect alert already went out
        print(f"{label} cached-task alerts failed: {type(e).__name__}: {e}")


def _assign_cmid(row: Dict, previous: Optional[Dict]) -> Optional[int]:
    """Course module id of an assignment row (None for other activities)."""
    url = str((previous or {}).get("task_url") or row.get("task_url") or "")
    if "/mod/assign/" not in url:
        return None
    if previous and previous.get("course_module_id"):
        return int(previous["course_module_id"])
    match = _CMID_RE.search(url)
    return int(match.group(1)) if match else None


def _load_missing_counts(storage, user_id: str) -> Dict[str, int]:
    try:
        raw = json.loads(storage.get_setting(missing_setting_key(user_id), "") or "{}")
    except ValueError:
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): int(v) for k, v in raw.items() if isinstance(v, int)}


def reconcile_missing_tasks(
    storage,
    supabase: Any,
    client: Any,
    user_id: str,
    fetched: List[Dict],
    label: str = "[ApiSync]",
    previous: Optional[Dict[str, Dict]] = None,
    now: Optional[float] = None,
) -> Dict[str, int]:
    """Reconcile the user's local tasks that a COMPLETE fetch no longer returned.

    Candidates are the user's visible (not muted) rows, not submitted, due within the overdue window,
    and absent from ``fetched``. An assignment among them is re-checked once per round (while it is
    not flagged yet): submitted -> saved as submitted. The rest count one absent round each; after
    ``MISSING_ROUNDS`` in a row they are flagged through ``supabase.mark_tasks_missing`` when the
    data layer has it. A row that reappears drops its counter. Raises on a Moodle error so the
    caller skips the whole pass (nothing is half-applied).
    """
    now = time.time() if now is None else now
    previous = previous or {}
    fetched_ids = {str(t["id"]) for t in fetched}
    floor = now - OVERDUE_WINDOW_DAYS * 86400 + 3600  # an hour of margin against the window edge
    candidates = [
        t for t in storage.get_all_tasks(order_by_due=False, user_id=user_id)
        if str(t["id"]) not in fetched_ids and t.get("status") != "submitted"
        and int(t.get("due_timestamp") or 0) >= floor
    ]
    counts = _load_missing_counts(storage, user_id)
    submitted: List[Dict] = []
    missing: List[str] = []
    checks = 0
    for row in candidates:
        task_id = str(row["id"])
        prev = previous.get(task_id)
        cmid = _assign_cmid(row, prev)
        if cmid and counts.get(task_id, 0) < MISSING_ROUNDS and checks < RECONCILE_MAX_CHECKS:
            if checks and RECONCILE_DELAY:
                time.sleep(RECONCILE_DELAY)
            checks += 1
            status, used_id = client._assign_status((prev or {}).get("assign_id"), cmid)
            if status == "submitted":
                task = dict(prev or row)
                task.update(status="submitted", status_source="api", user_id=user_id)
                if used_id:
                    task["assign_id"] = used_id
                submitted.append(task)
                continue
        missing.append(task_id)

    new_counts = {tid: min(counts.get(tid, 0) + 1, MISSING_ROUNDS) for tid in missing}
    to_mark = [tid for tid in missing if counts.get(tid, 0) < MISSING_ROUNDS <= new_counts[tid]]
    if submitted:
        storage.save_tasks(submitted)
        print(f"{label} reconciliation: {len(submitted)} vanished assignment(s) were submitted.")
    mark = getattr(supabase, "mark_tasks_missing", None)
    if to_mark and callable(mark):
        try:
            marked = mark(user_id, to_mark)
        except Exception as e:  # noqa: BLE001
            print(f"{label} reconciliation: could not flag missing tasks: {type(e).__name__}")
            marked = False
        if marked is False:
            for tid in to_mark:  # retried on the next complete round
                new_counts[tid] = MISSING_ROUNDS - 1
        else:
            print(f"{label} reconciliation: {len(to_mark)} task(s) no longer in Moodle flagged missing.")
    encoded = json.dumps(new_counts, sort_keys=True)
    if encoded != json.dumps(counts, sort_keys=True):  # write only on change (settings are mirrored)
        storage.set_setting(missing_setting_key(user_id), encoded)
    return {"submitted": len(submitted), "missing": len(missing), "flagged": len(to_mark)}


def _mark_synced(supabase: Any, user_id: str, label: str) -> None:
    mark = getattr(supabase, "set_user_synced", None)
    if not callable(mark):
        return
    try:
        mark(user_id)
    except Exception as e:  # noqa: BLE001 - bookkeeping only
        print(f"{label} could not record the sync time: {type(e).__name__}")


def sync_tasks_via_api(
    storage,
    creds: Credentials,
    supabase: Any = None,
    client: Optional[MoodleApiClient] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
    user: Optional[Dict] = None,
    deliver: Optional[Callable] = None,
    breaker: Optional[CircuitBreaker] = None,
) -> str:
    process = process or TaskNotificationManager.process_milestones
    if alert is None:
        alert = _user_alert(deliver, user) if (deliver is not None and user) else send_system_alert
    user_id = str(user["id"]) if user else None
    # Per-user mode: everything is addressed to this user's own topic, never to the env owner topic.
    route: Dict[str, Any] = {"topic": user["ntfy_topic"]} if user else {}
    label = f"[ApiSync user {user_id[:8]}]" if user else "[ApiSync]"
    alert_key = alert_setting_key(user_id)

    if user is not None and token_rejected_since_login(user):
        # Moodle already rejected this token and no login refreshed it: do not ask Moodle again.
        print(f"{label} token rejected and no login since; Moodle is not called until the next login.")
        _alert_disconnected(storage, alert, alert_key, creds, user, route)
        _notify_cached_tasks(storage, user, deliver, process, route, label)
        return "invalid"

    client = client or MoodleApiClient(creds.base_url, creds.token, user_id=user_id)

    try:
        tasks = client.fetch_tasks()
    except MoodleTokenInvalid as e:
        if breaker is not None:
            breaker.record_reachable()
        print(f"{label} token rejected ({e.code}): {e}")
        _report_error(supabase, creds, f"{e.code or 'invalidtoken'}: {e}", user)
        _alert_disconnected(storage, alert, alert_key, creds, user, route)
        _notify_cached_tasks(storage, user, deliver, process, route, label)
        return "invalid"
    except MoodleApiError as e:
        if breaker is not None:
            if getattr(e, "is_network", False):
                breaker.record_network_error()
            else:
                breaker.record_reachable()
        print(f"{label} Moodle API error ({e.code}): {e}")
        return "error"
    except Exception as e:
        print(f"{label} unexpected error: {e}")
        return "error"
    if breaker is not None:
        breaker.record_reachable()

    try:
        if user_id:
            for t in tasks:
                t["user_id"] = user_id  # the owner is authoritative; never trust the client
        new_tasks, _ = storage.save_tasks(tasks)
        notify = True
        if user_id:
            notify = _apply_web_mutes(storage, supabase, user_id, tasks, label)
        if apply_migration_guard(storage, tasks, user_id):
            print(f"{label} first sync: {len(tasks)} existing tasks marked as already announced.")
        # Announce every fetched task whose 'new' alert never got through, not only the rows inserted
        # this round: a failed delivery (or a round without notifications) is retried on the next sync.
        unannounced = [t for t in tasks if not storage.has_notified_milestone(str(t["id"]), "new")]
        mirror_ok = getattr(storage, "last_task_mirror_ok", None)
        mirror = {True: "ok", False: "FAILED"}.get(mirror_ok, "n/a")
        print(f"{label} {len(tasks)} tasks fetched, {len(new_tasks)} new (supabase mirror: {mirror}).")
        if user_id:
            if notify:
                extra = {"deliver": partial(deliver, user)} if deliver is not None else {}
                process(tasks, storage, new_tasks=unannounced, topic=route["topic"], desktop=False, **extra)
            else:
                print(f"{label} notifications skipped this round (muted tasks unknown).")
        else:
            process(tasks, storage, new_tasks=unannounced)
    except Exception as e:
        print(f"{label} error while storing/notifying: {e}")
        return "error"

    if user_id:
        previous = _LAST_FETCHED.get(user_id, {})
        _LAST_FETCHED[user_id] = {str(t["id"]): dict(t) for t in tasks}
        if getattr(client, "last_fetch_complete", None) is True:
            try:
                reconcile_missing_tasks(storage, supabase, client, user_id, tasks, label, previous=previous)
            except Exception as e:  # noqa: BLE001 - reconciliation is best effort, retried next round
                print(f"{label} reconciliation skipped: {getattr(e, 'code', '') or type(e).__name__}")
        elif getattr(client, "last_fetch_complete", None) is False:
            print(f"{label} calendar fetch truncated; reconciliation skipped this round.")

    if storage.get_setting(alert_key, ""):
        sent = alert(title="Moodle reconectado", message="La conexión con UTM Moodle se restableció.",
                     priority="default", tags="white_check_mark,mortarboard", **route)
        if sent is not False:  # False = no channel got through: keep the key so the next sync retries
            storage.set_setting(alert_key, "")
            _report_error(supabase, creds, None, user)
    elif user and user.get("last_error"):
        _report_error(supabase, creds, None, user)  # error recorded elsewhere (e.g. web), now healthy
    if mirror_ok is False:
        # Moodle and the local store are fine, but the cloud copy is stale: do not report a clean "ok".
        print(f"{label} tasks were NOT mirrored to Supabase this round (see [Supabase] log above).")
        return "error"
    if user_id:
        _mark_synced(supabase, user_id, label)
    return "ok"


def sync_user_via_api(
    storage,
    user: Dict,
    supabase: Any = None,
    client: Optional[MoodleApiClient] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
    deliver: Optional[Callable] = None,
    breaker: Optional[CircuitBreaker] = None,
) -> str:
    """Sync one ``moodle_users`` row (needs id, moodle_url, token, ntfy_topic). Never raises."""
    try:
        creds = Credentials(str(user["token"]).strip(), str(user["moodle_url"]), "user")
        return sync_tasks_via_api(
            storage, creds, supabase, client=client, process=process, alert=alert, user=user, deliver=deliver,
            breaker=breaker,
        )
    except Exception as e:
        print(f"[ApiSync] user sync failed: {e}")
        return "error"
