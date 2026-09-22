import os
import time
from datetime import datetime
from moodle_client import MoodleClient
from notifier import TaskNotificationManager, send_system_alert
from storage import Storage


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


def run_worker():
    """Ejecutor en segundo plano sin interfaz gráfica con Keep-Alive y alerta de sesión."""
    storage = Storage()

    base_url = os.environ.get("MOODLE_URL") or storage.get_setting("moodle_url", "https://evirtual.utm.edu.ec")
    session_cookie = _read_env_cookie() or storage.get_setting("moodle_session", "")

    if not session_cookie:
        print("[!] ERROR: No hay cookie de Moodle configurada en .env ni en la base de datos.")
        return

    # Guardar en settings
    storage.set_setting("moodle_url", base_url)
    storage.set_setting("moodle_session", session_cookie)

    keep_alive_seconds = 300  # 5 minutos
    try:
        tasks_check_mins = int(storage.get_setting("check_interval_mins", "30"))
    except ValueError:
        tasks_check_mins = 30
    tasks_check_seconds = tasks_check_mins * 60

    print("=" * 60)
    print("  🚀 MOODLE TRACKER - HEADLESS WORKER CON KEEP-ALIVE")
    print(f"  🌐 URL: {base_url}")
    print(f"  ☁️ Supabase Cloud: {'Conectado' if storage.supabase.is_configured else 'Desactivado'}")
    print(f"  💓 Keep-Alive: cada {keep_alive_seconds // 60} minutos")
    print(f"  📋 Revisión de tareas: cada {tasks_check_mins} minutos")
    print("=" * 60)

    last_tasks_check = 0.0
    session_expired_notified = False

    while True:
        now_ts = time.time()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Recargar cookie fresca desde .env si fue modificada en disco
        current_cookie = _read_env_cookie() or storage.get_setting("moodle_session", "")
        if current_cookie and current_cookie != session_cookie:
            print(f"[{now_str}] 🔄 Se detectó actualización de cookie en .env.")
            session_cookie = current_cookie
            storage.set_setting("moodle_session", session_cookie)

        client = MoodleClient(base_url, session_cookie)
        should_check_tasks = (now_ts - last_tasks_check) >= tasks_check_seconds

        if should_check_tasks:
            print(f"\n[{now_str}] 📋 Verificando calendario de Moodle y actualizando tareas...")
            try:
                success, tasks, msg = client.fetch_upcoming_tasks()

                if success:
                    last_tasks_check = time.time()
                    new_tasks, _ = storage.save_tasks(tasks)
                    print(f"[{now_str}] {msg}")
                    print(f"[{now_str}] Tareas nuevas detectadas: {len(new_tasks)}")

                    # Disparar los 5 hitos
                    TaskNotificationManager.process_milestones(tasks, storage, new_tasks=new_tasks)

                    # Si veníamos de una sesión caída, notificar restablecimiento
                    if session_expired_notified:
                        send_system_alert(
                            title="Sesión de Moodle restablecida",
                            message="La conexión con UTM Moodle se recuperó con éxito. Monitoreo normal reanudado.",
                            priority="default",
                            tags="white_check_mark,mortarboard",
                        )
                        session_expired_notified = False
                else:
                    print(f"[{now_str}] [!] Error al consultar Moodle: {msg}")
                    if "login" in msg.lower() or "caducado" in msg.lower() or "inválida" in msg.lower():
                        if not session_expired_notified:
                            print(f"[{now_str}] 🚨 Notificando a ntfy: Sesión expirada.")
                            send_system_alert(
                                title="⚠️ Sesión de Moodle UTM caducada",
                                message="Tu cookie de sesión ha expirado. Por favor actualiza MOODLE_SESSION en tu archivo .env para seguir rastreando tareas.",
                                priority="urgent",
                                tags="warning,rotating_light",
                                click_url=f"{base_url}/login/index.php",
                            )
                            session_expired_notified = True

            except Exception as err:
                print(f"[{now_str}] [!] Excepción en tareas: {err}")

        else:
            # Petición liviana de Keep-Alive
            try:
                is_alive, msg = client.test_connection()
                if is_alive:
                    print(f"[{now_str}] 💓 Keep-Alive OK: Sesión activa y timestamp renovado.")
                    if session_expired_notified:
                        send_system_alert(
                            title="Sesión de Moodle restablecida",
                            message="La conexión con UTM Moodle se recuperó con éxito. Monitoreo normal reanudado.",
                            priority="default",
                            tags="white_check_mark,mortarboard",
                        )
                        session_expired_notified = False
                else:
                    print(f"[{now_str}] ⚠️ Keep-Alive falló: {msg}")
                    if "login" in msg.lower() or "caducado" in msg.lower() or "inválida" in msg.lower():
                        if not session_expired_notified:
                            print(f"[{now_str}] 🚨 Notificando a ntfy: Sesión expirada.")
                            send_system_alert(
                                title="⚠️ Sesión de Moodle UTM caducada",
                                message="Tu cookie de sesión ha expirado. Por favor actualiza MOODLE_SESSION en tu archivo .env para seguir rastreando tareas.",
                                priority="urgent",
                                tags="warning,rotating_light",
                                click_url=f"{base_url}/login/index.php",
                            )
                            session_expired_notified = True
            except Exception as err:
                print(f"[{now_str}] [!] Error en Keep-Alive: {err}")

        # Dormir el intervalo de keep-alive (5 minutos)
        time.sleep(keep_alive_seconds)


if __name__ == "__main__":
    run_worker()
