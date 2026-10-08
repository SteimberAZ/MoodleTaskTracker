"""Task synchronisation through the Moodle web service (token based).

``sync_tasks_via_api`` never raises: it returns ``"ok"``, ``"invalid"`` (token rejected) or
``"error"`` (transient failure) so the worker loop can decide what to do next.
"""
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from moodle_api import Credentials, MoodleApiClient, MoodleApiError, MoodleTokenInvalid
from notifier import TaskNotificationManager, send_system_alert

MIGRATION_FLAG = "api_migration_done"
ALERT_SETTING = "api_token_alert_fingerprint"

DISCONNECTED_TITLE = "Moodle desconectado"
DISCONNECTED_MESSAGE = "Moodle desconectado: vuelve a conectar tu cuenta en la web"


def apply_migration_guard(storage, tasks: List[Dict]) -> bool:
    """One-time guard for the first API-based sync.

    Task ids from the API may not match the ids stored by the cookie scraper. To avoid a burst of
    "new task" alerts for tasks the user already knows, pre-record the ``new`` milestone for every
    fetched task. Returns True when the guard ran (so the caller can treat nothing as new).
    """
    if storage.get_setting(MIGRATION_FLAG, "") == "1":
        return False
    for t in tasks:
        storage.record_milestone(str(t["id"]), "new")
    storage.set_setting(MIGRATION_FLAG, "1")
    return True


def _report_error(supabase: Any, creds: Credentials, message: Optional[str]):
    if creds.source != "supabase" or supabase is None:
        return
    fields = {"last_error": message, "last_error_at": datetime.now(timezone.utc).isoformat() if message else None}
    try:
        supabase.update_credentials(fields)
    except Exception as e:
        print(f"[ApiSync] could not update moodle_credentials: {e}")


def sync_tasks_via_api(
    storage,
    creds: Credentials,
    supabase: Any = None,
    client: Optional[MoodleApiClient] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
) -> str:
    process = process or TaskNotificationManager.process_milestones
    alert = alert or send_system_alert
    client = client or MoodleApiClient(creds.base_url, creds.token)

    try:
        tasks = client.fetch_tasks()
    except MoodleTokenInvalid as e:
        print(f"[ApiSync] token rejected ({e.code}): {e}")
        _report_error(supabase, creds, f"{e.code or 'invalidtoken'}: {e}")
        if storage.get_setting(ALERT_SETTING, "") != creds.fingerprint:
            alert(title=DISCONNECTED_TITLE, message=DISCONNECTED_MESSAGE, priority="urgent",
                  tags="warning,rotating_light")
            storage.set_setting(ALERT_SETTING, creds.fingerprint)
        return "invalid"
    except MoodleApiError as e:
        print(f"[ApiSync] Moodle API error ({e.code}): {e}")
        return "error"
    except Exception as e:
        print(f"[ApiSync] unexpected error: {e}")
        return "error"

    try:
        new_tasks, _ = storage.save_tasks(tasks)
        if apply_migration_guard(storage, tasks):
            print(f"[ApiSync] first API sync: {len(tasks)} existing tasks marked as already announced.")
        print(f"[ApiSync] {len(tasks)} tasks fetched, {len(new_tasks)} new.")
        process(tasks, storage, new_tasks=new_tasks)
    except Exception as e:
        print(f"[ApiSync] error while storing/notifying: {e}")
        return "error"

    if storage.get_setting(ALERT_SETTING, ""):
        storage.set_setting(ALERT_SETTING, "")
        _report_error(supabase, creds, None)
        alert(title="Moodle reconectado", message="La conexión con UTM Moodle se restableció.",
              priority="default", tags="white_check_mark,mortarboard")
    return "ok"
