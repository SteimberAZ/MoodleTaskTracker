import os
import sys
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from moodle_client import MoodleClient
from notifier import TaskNotificationManager, mask_topic, ntfy_base_url, post_ntfy, send_system_alert
from storage import Storage
from class_schedule import check_and_notify_upcoming_classes
from custom_reminders import process_due_reminders
from supabase_client import SupabaseClient
from moodle_api import resolve_credentials
from api_sync import sync_tasks_via_api, sync_user_via_api


def _read_env_cookie():
    """Lee dinámicamente MOODLE_SESSION desde el archivo .env si existe."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("MOODLE_SESSION="):
                        val = line.split("=", 1)[1].strip()
                        if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                            val = val[1:-1]
                        return val
        except Exception:
            pass
    return os.environ.get("MOODLE_SESSION", "")


class LegacyState:
    """Mutable state of the legacy single-user (env/cookie) path."""

    def __init__(self):
        self.session_expired_notified = False
        self.api_active = False  # True while the last sync went through the web-service token


def sync_all_users(
    storage,
    supabase,
    users: List[Dict],
    client_factory: Optional[Callable[[Dict], Any]] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
) -> Dict[str, str]:
    """Sync every user in isolation: one user's failure never blocks the others.

    Returns {user_id: "ok" | "invalid" | "error" | "skipped"}. Notifications of a user only go to
    that user's own ntfy topic; a user without a topic is skipped (never falls back to the owner's).
    """
    outcomes: Dict[str, str] = {}
    for user in users:
        user_id = str(user.get("id", ""))
        topic = str(user.get("ntfy_topic") or "").strip()
        tag = f"user {user_id[:8]} ({mask_topic(topic)})"
        if not user_id or not topic or not str(user.get("token") or "").strip():
            print(f"[Worker] {tag}: incomplete user row (id/topic/token); skipped.")
            outcomes[user_id] = "skipped"
            continue
        try:
            client = client_factory(user) if client_factory else None
            outcomes[user_id] = sync_user_via_api(
                storage, user, supabase, client=client, process=process, alert=alert
            )
        except Exception as err:  # sync_user_via_api never raises; belt and braces
            print(f"[Worker] {tag}: unexpected error: {err}")
            outcomes[user_id] = "error"
        print(f"[Worker] {tag}: {outcomes[user_id]}")
    return outcomes


def run_task_tick(
    storage,
    supabase,
    legacy_check: Callable[[], None],
    client_factory: Optional[Callable[[Dict], Any]] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
) -> str:
    """One task-sync round. Returns which path ran: "users", "legacy" or "skipped".

    * active users with tokens exist -> sync each of them, legacy path never runs;
    * the users table is readable and empty -> legacy env/cookie path (``legacy_check``);
    * the users fetch failed -> skip the round entirely (no legacy fallback, so the owner does not
      get duplicate alerts while multi-user mode is merely unreachable).
    """
    try:
        users = supabase.fetch_active_users()
    except Exception as err:
        print(f"[Worker] [!] No se pudo leer moodle_users ({err}); se omite esta revisión (sin respaldo legacy).")
        return "skipped"
    if users:
        print(f"[Worker] 👥 Usuarios activos: {len(users)}")
        sync_all_users(storage, supabase, users, client_factory=client_factory, process=process, alert=alert)
        return "users"
    legacy_check()
    return "legacy"


def legacy_check_tasks(storage, supabase, state: LegacyState, base_url: str, session_cookie: str, now_str: str):
    """Legacy single-user check: web-service token (env/credentials) first, cookie scrape as fallback."""
    client = MoodleClient(base_url, session_cookie)
    api_outcome = None
    creds = resolve_credentials(supabase)
    if creds:
        print(f"[{now_str}] 🔑 Usando token de la API de Moodle ({creds.source}).")
        api_outcome = sync_tasks_via_api(storage, creds, supabase)
    state.api_active = api_outcome in ("ok", "error")
    if api_outcome == "invalid" and session_cookie:
        print(f"[{now_str}] ⚠️ Token inválido; usando cookie de sesión como respaldo.")

    if api_outcome in ("ok", "error"):
        return  # errors are logged by sync_tasks_via_api and retried next cycle
    if not session_cookie:
        print(f"[{now_str}] [!] Sin token ni cookie de Moodle configurados; nada que revisar.")
        return
    try:
        success, tasks, msg = client.fetch_upcoming_tasks()

        if success:
            new_tasks, _ = storage.save_tasks(tasks)
            print(f"[{now_str}] {msg}")
            print(f"[{now_str}] Tareas nuevas detectadas: {len(new_tasks)}")

            # Disparar los 5 hitos
            TaskNotificationManager.process_milestones(tasks, storage, new_tasks=new_tasks)

            # Si veníamos de una sesión caída, notificar restablecimiento
            if state.session_expired_notified:
                send_system_alert(
                    title="Sesión de Moodle restablecida",
                    message="La conexión con UTM Moodle se recuperó con éxito. Monitoreo normal reanudado.",
                    priority="default",
                    tags="white_check_mark,mortarboard",
                )
                state.session_expired_notified = False
        else:
            print(f"[{now_str}] [!] Error al consultar Moodle: {msg}")
            _alert_session_expired(state, msg, base_url, now_str)
    except Exception as err:
        print(f"[{now_str}] [!] Excepción en tareas: {err}")


def _alert_session_expired(state: LegacyState, msg: str, base_url: str, now_str: str):
    if "login" in msg.lower() or "caducado" in msg.lower() or "inválida" in msg.lower():
        if not state.session_expired_notified:
            print(f"[{now_str}] 🚨 Notificando a ntfy: Sesión expirada.")
            send_system_alert(
                title="⚠️ Sesión de Moodle UTM caducada",
                message="Tu cookie de sesión ha expirado. Por favor actualiza MOODLE_SESSION en tu archivo .env para seguir rastreando tareas.",
                priority="urgent",
                tags="warning,rotating_light",
                click_url=f"{base_url}/login/index.php",
            )
            state.session_expired_notified = True


def legacy_keep_alive(state: LegacyState, base_url: str, session_cookie: str, now_str: str):
    """Lightweight cookie keep-alive (legacy path only)."""
    client = MoodleClient(base_url, session_cookie)
    try:
        is_alive, msg = client.test_connection()
        if is_alive:
            print(f"[{now_str}] 💓 Keep-Alive OK: Sesión activa y timestamp renovado.")
            if state.session_expired_notified:
                send_system_alert(
                    title="Sesión de Moodle restablecida",
                    message="La conexión con UTM Moodle se recuperó con éxito. Monitoreo normal reanudado.",
                    priority="default",
                    tags="white_check_mark,mortarboard",
                )
                state.session_expired_notified = False
        else:
            print(f"[{now_str}] ⚠️ Keep-Alive falló: {msg}")
            _alert_session_expired(state, msg, base_url, now_str)
    except Exception as err:
        print(f"[{now_str}] [!] Error en Keep-Alive: {err}")


def deliver_reminder(title: str, body: str, topic: str) -> bool:
    """Send one custom reminder to its owner's own ntfy topic."""
    return post_ntfy(title, body, priority="high", tags="alarm_clock,bell", topic=topic)


def run_worker():
    """Ejecutor en segundo plano: tareas y recordatorios por usuario + recordatorio de clases 30m (dueño)."""
    storage = Storage()

    base_url = os.environ.get("MOODLE_URL") or storage.get_setting("moodle_url", "https://evirtual.utm.edu.ec")
    session_cookie = _read_env_cookie() or storage.get_setting("moodle_session", "")

    # Legacy only: the cookie is used when there are no active users with a Moodle token.
    if session_cookie:
        storage.set_setting("moodle_session", session_cookie)  # local only, never mirrored
    storage.set_setting("moodle_url", base_url)

    keep_alive_seconds = 300  # 5 minutos
    try:
        tasks_check_mins = int(storage.get_setting("check_interval_mins", "30"))
    except ValueError:
        tasks_check_mins = 30
    tasks_check_seconds = tasks_check_mins * 60

    print("=" * 60)
    print("  🚀 MOODLE TRACKER - HEADLESS WORKER (MULTIUSUARIO)")
    print(f"  🌐 URL por defecto: {base_url}")
    db_host = urlparse(storage.supabase.url).netloc if storage.supabase.is_configured else ""
    print(f"  🗄️ Base de datos: {db_host or 'Desactivada (solo SQLite local)'}")
    print(f"  🔔 ntfy: {ntfy_base_url()}")
    print(f"  💓 Keep-Alive (modo legacy): cada {keep_alive_seconds // 60} minutos")
    print(f"  📋 Revisión de tareas: cada {tasks_check_mins} minutos")
    print("  🎓 Alertas de clases (solo dueño): 30 minutos antes de cada materia")
    print("=" * 60)

    supabase = SupabaseClient.for_worker()

    last_tasks_check = 0.0
    last_keep_alive = 0.0
    legacy = LegacyState()
    mode = "skipped"  # which path the last task round took: "users" | "legacy" | "skipped"

    while True:
        now_ts = time.time()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 1. Monitoreo del horario de clases universitarias (owner only, env NTFY_TOPIC)
        try:
            check_and_notify_upcoming_classes(storage)
        except Exception as err:
            print(f"[{now_str}] [!] Error en recordatorio de clases: {err}")

        # 1b. Custom reminders (Supabase -> each owner's ntfy topic)
        try:
            process_due_reminders(supabase, deliver_reminder)
        except Exception as err:
            print(f"[{now_str}] [!] Error en recordatorios personalizados: {err}")

        # 2. Recargar cookie fresca desde .env si fue modificada en disco (legacy path)
        current_cookie = _read_env_cookie() or storage.get_setting("moodle_session", "")
        if current_cookie and current_cookie != session_cookie:
            print(f"[{now_str}] 🔄 Se detectó actualización de cookie en .env.")
            session_cookie = current_cookie
            storage.set_setting("moodle_session", session_cookie)

        should_check_tasks = (now_ts - last_tasks_check) >= tasks_check_seconds
        should_keep_alive = (now_ts - last_keep_alive) >= keep_alive_seconds and not legacy.api_active

        if should_check_tasks:
            print(f"\n[{now_str}] 📋 Verificando Moodle y actualizando tareas...")
            last_tasks_check = time.time()
            last_keep_alive = time.time()
            mode = run_task_tick(
                storage,
                supabase,
                legacy_check=lambda: legacy_check_tasks(storage, supabase, legacy, base_url, session_cookie, now_str),
            )
        elif should_keep_alive and mode == "legacy" and session_cookie:
            last_keep_alive = time.time()
            legacy_keep_alive(legacy, base_url, session_cookie, now_str)

        # Tick cada 60 segundos para evaluar con precisión el horario de clases
        time.sleep(60)


if __name__ == "__main__":
    run_worker()
