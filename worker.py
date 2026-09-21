import os
import time
from datetime import datetime
from moodle_client import MoodleClient
from notifier import TaskNotificationManager
from storage import Storage


def run_worker():
    """Ejecutor en segundo plano sin interfaz gráfica (ideal para VPS Linux o Docker)."""
    storage = Storage()

    base_url = os.environ.get("MOODLE_URL") or storage.get_setting("moodle_url", "https://evirtual.utm.edu.ec")
    session_cookie = os.environ.get("MOODLE_SESSION") or storage.get_setting("moodle_session", "")

    if not session_cookie:
        print("[!] ERROR: No hay cookie de Moodle configurada en .env ni en la base de datos.")
        return

    # Guardar en settings por si se pasaron por variables de entorno
    storage.set_setting("moodle_url", base_url)
    storage.set_setting("moodle_session", session_cookie)

    print("=" * 60)
    print("  🚀 MOODLE TRACKER - HEADLESS WORKER (VPS / SERVIDOR)")
    print(f"  🌐 URL: {base_url}")
    print(f"  ☁️ Supabase Cloud: {'Conectado' if storage.supabase.is_configured else 'Desactivado'}")
    print("=" * 60)

    while True:
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n[{now_str}] Verificando calendario de Moodle...")

        try:
            client = MoodleClient(base_url, session_cookie)
            success, tasks, msg = client.fetch_upcoming_tasks()

            if success:
                new_tasks, _ = storage.save_tasks(tasks)
                print(f"[{now_str}] {msg}")
                print(f"[{now_str}] Tareas nuevas detectadas: {len(new_tasks)}")

                # Disparar los 5 hitos (nueva, 3d, 2d, 1d, 8h)
                TaskNotificationManager.process_milestones(tasks, storage, new_tasks=new_tasks)
            else:
                print(f"[{now_str}] [!] Error al consultar Moodle: {msg}")

        except Exception as err:
            print(f"[{now_str}] [!] Excepción inesperada: {err}")

        try:
            interval_mins = int(storage.get_setting("check_interval_mins", "30"))
        except ValueError:
            interval_mins = 30

        print(f"[*] Próximo chequeo en {interval_mins} minutos...")
        time.sleep(interval_mins * 60)


if __name__ == "__main__":
    run_worker()
