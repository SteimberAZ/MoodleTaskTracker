"""Task synchronisation through the Moodle web service (token based).

``sync_tasks_via_api`` never raises: it returns ``"ok"``, ``"invalid"`` (token rejected) or
``"error"`` (transient failure) so the worker loop can decide what to do next.

Two modes share one implementation:
  * legacy single-user: ``creds`` from ``resolve_credentials``, alerts to the env ntfy topic;
  * multi-user (``user=`` row from ``moodle_users``): per-user task ids, first-sync guard and
    token-alert dedup state, errors recorded on the user row, notifications to the user's topic or,
    when the worker passes ``deliver`` (delivery.deliver_to_user), to every channel of the user
    (Web Push first, ntfy optional).
"""
from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable, Dict, List, Optional

from moodle_api import Credentials, MoodleApiClient, MoodleApiError, MoodleTokenInvalid
from notifier import TaskNotificationManager, send_system_alert

MIGRATION_FLAG = "api_migration_done"
ALERT_SETTING = "api_token_alert_fingerprint"

DISCONNECTED_TITLE = "Moodle desconectado"
DISCONNECTED_MESSAGE = "Moodle desconectado: vuelve a conectar tu cuenta en la web"
USER_DISCONNECTED_MESSAGE = "Moodle desconectado: vuelve a iniciar sesión en la web"


def migration_flag_key(user_id: Optional[str] = None) -> str:
    """Local-settings key of the first-sync guard (one per user in multi-user mode)."""
    return f"{MIGRATION_FLAG}:{user_id}" if user_id else MIGRATION_FLAG


def alert_setting_key(user_id: Optional[str] = None) -> str:
    """Local-settings key holding the fingerprint of the token an alert was already sent for."""
    return f"{ALERT_SETTING}:{user_id}" if user_id else ALERT_SETTING


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


def sync_tasks_via_api(
    storage,
    creds: Credentials,
    supabase: Any = None,
    client: Optional[MoodleApiClient] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
    user: Optional[Dict] = None,
    deliver: Optional[Callable] = None,
) -> str:
    process = process or TaskNotificationManager.process_milestones
    if alert is None:
        alert = _user_alert(deliver, user) if (deliver is not None and user) else send_system_alert
    user_id = str(user["id"]) if user else None
    # Per-user mode: everything is addressed to this user's own topic, never to the env owner topic.
    route: Dict[str, Any] = {"topic": user["ntfy_topic"]} if user else {}
    label = f"[ApiSync user {user_id[:8]}]" if user else "[ApiSync]"
    alert_key = alert_setting_key(user_id)
    client = client or MoodleApiClient(creds.base_url, creds.token, user_id=user_id)

    try:
        tasks = client.fetch_tasks()
    except MoodleTokenInvalid as e:
        print(f"{label} token rejected ({e.code}): {e}")
        _report_error(supabase, creds, f"{e.code or 'invalidtoken'}: {e}", user)
        if storage.get_setting(alert_key, "") != creds.fingerprint:
            sent = alert(
                title=DISCONNECTED_TITLE,
                message=USER_DISCONNECTED_MESSAGE if user else DISCONNECTED_MESSAGE,
                priority="urgent",
                tags="warning,rotating_light",
                **route,
            )
            if sent is not False:  # False = no channel got through: leave it unrecorded, retry next sync
                storage.set_setting(alert_key, creds.fingerprint)
        return "invalid"
    except MoodleApiError as e:
        print(f"{label} Moodle API error ({e.code}): {e}")
        return "error"
    except Exception as e:
        print(f"{label} unexpected error: {e}")
        return "error"

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
        mirror_ok = getattr(storage, "last_task_mirror_ok", None)
        mirror = {True: "ok", False: "FAILED"}.get(mirror_ok, "n/a")
        print(f"{label} {len(tasks)} tasks fetched, {len(new_tasks)} new (supabase mirror: {mirror}).")
        if user_id:
            if notify:
                extra = {"deliver": partial(deliver, user)} if deliver is not None else {}
                process(tasks, storage, new_tasks=new_tasks, topic=route["topic"], desktop=False, **extra)
            else:
                print(f"{label} notifications skipped this round (muted tasks unknown).")
        else:
            process(tasks, storage, new_tasks=new_tasks)
    except Exception as e:
        print(f"{label} error while storing/notifying: {e}")
        return "error"

    if storage.get_setting(alert_key, ""):
        storage.set_setting(alert_key, "")
        _report_error(supabase, creds, None, user)
        alert(title="Moodle reconectado", message="La conexión con UTM Moodle se restableció.",
              priority="default", tags="white_check_mark,mortarboard", **route)
    elif user and user.get("last_error"):
        _report_error(supabase, creds, None, user)  # error recorded elsewhere (e.g. web), now healthy
    if mirror_ok is False:
        # Moodle and the local store are fine, but the cloud copy is stale: do not report a clean "ok".
        print(f"{label} tasks were NOT mirrored to Supabase this round (see [Supabase] log above).")
        return "error"
    return "ok"


def sync_user_via_api(
    storage,
    user: Dict,
    supabase: Any = None,
    client: Optional[MoodleApiClient] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
    deliver: Optional[Callable] = None,
) -> str:
    """Sync one ``moodle_users`` row (needs id, moodle_url, token, ntfy_topic). Never raises."""
    try:
        creds = Credentials(str(user["token"]).strip(), str(user["moodle_url"]), "user")
        return sync_tasks_via_api(
            storage, creds, supabase, client=client, process=process, alert=alert, user=user, deliver=deliver
        )
    except Exception as e:
        print(f"[ApiSync] user sync failed: {e}")
        return "error"
