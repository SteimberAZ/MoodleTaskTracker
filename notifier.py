import os
import subprocess
import sys
from typing import Dict, List, Optional


def send_windows_notification(title: str, message: str, app_name: str = "Moodle Tracker"):
    """Envía una notificación de escritorio nativa en Windows mediante Toast Notification."""
    # 1. PowerShell Windows Runtime Toast (Nativo de Windows 10/11, máxima estabilidad)
    try:
        safe_title = title.replace("'", "''").replace('"', '`"').replace("\n", " ")
        safe_msg = message.replace("'", "''").replace('"', '`"').replace("\n", " `n ")

        ps_script = (
            "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; "
            "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02; "
            "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template); "
            "$textNodes = $xml.GetElementsByTagName('text'); "
            f"$textNodes.Item(0).AppendChild($xml.CreateTextNode('{safe_title}')) | Out-Null; "
            f"$textNodes.Item(1).AppendChild($xml.CreateTextNode('{safe_msg}')) | Out-Null; "
            "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml); "
            f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{app_name}').Show($toast);"
        )

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        subprocess.Popen(
            ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps_script],
            creationflags=creationflags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    except Exception:
        pass

    # 2. Respaldo secundario con plyer
    try:
        from plyer import notification
        base_dir = os.path.dirname(os.path.abspath(__file__))
        icon_path = os.path.join(base_dir, "icon.ico")
        if not os.path.exists(icon_path):
            icon_path = ""

        notification.notify(
            title=title,
            message=message,
            app_name=app_name,
            app_icon=icon_path if icon_path else None,
            timeout=8,
        )
    except Exception:
        pass


def send_whatsapp_alert(
    title: str,
    course: str,
    due_date: str,
    task_url: str = "",
    milestone: str = "new",
    is_urgent: bool = False,
):
    """Envía la alerta directamente a la app móvil ntfy con sonido, prioridad y enlace directo."""
    def _do_post():
        topic = os.environ.get("NTFY_TOPIC", "utm-tareas-randy-az")
        if not topic:
            return

        priority = "default"
        tags = "books,calendar"
        header = "🔔 Nueva tarea en Moodle UTM"

        if milestone == "8h":
            priority = "urgent"
            tags = "rotating_light,warning,books"
            header = "🚨 ¡URGENTE! Faltan menos de 8 horas"
        elif milestone == "1d":
            priority = "high"
            tags = "warning,books"
            header = "⚠️ Recordatorio: ¡Falta 1 día!"
        elif milestone == "2d":
            priority = "default"
            tags = "hourglass,books"
            header = "⏳ Recordatorio: Faltan 2 días"
        elif milestone == "3d":
            priority = "default"
            tags = "calendar,books"
            header = "📅 Recordatorio: Faltan 3 días"

        msg_lines = [
            f"📝 {title}",
            f"📚 {course or 'General'}",
            f"⏱️ Límite: {due_date or 'Sin fecha'}",
        ]
        body = "\n".join(msg_lines)

        headers = {
            "Title": header.encode("utf-8"),
            "Priority": priority,
            "Tags": tags,
        }
        if task_url:
            headers["Click"] = task_url

        try:
            import requests
            res = requests.post(
                f"https://ntfy.sh/{topic}",
                data=body.encode("utf-8"),
                headers=headers,
                timeout=10,
            )
            if res.status_code == 200:
                print(f"[Notifier] Notificación Push enviada ({milestone}) a ntfy.sh/{topic}")
            else:
                print(f"[Notifier] Error ntfy ({res.status_code}): {res.text}")
        except Exception as e:
            print(f"[Notifier] Error enviando a ntfy: {e}")

    import threading
    threading.Thread(target=_do_post, daemon=True).start()


class TaskNotificationManager:
    """Gestiona el análisis de tareas y el disparo de recordatorios según los 5 hitos configurados."""

    @staticmethod
    def process_milestones(tasks: List[Dict], storage, new_tasks: Optional[List[Dict]] = None):
        """
        Evalúa y envía los recordatorios para los 5 hitos:
        1. 'new': Tarea recién descubierta
        2. '3d': Faltan 3 días (<= 72 horas)
        3. '2d': Faltan 2 días (<= 48 horas)
        4. '1d': Falta 1 día (<= 24 horas)
        5. '8h': Faltan 8 horas (<= 8 horas)
        """
        import time
        now = int(time.time())

        # 1. Hito 'new' para tareas recién detectadas
        if new_tasks:
            for t in new_tasks:
                task_id = str(t.get("id"))
                if not storage.has_notified_milestone(task_id, "new"):
                    send_windows_notification(
                        title="🔔 ¡Nueva tarea agregada en Moodle!",
                        message=f"{t.get('title', 'Sin título')}\n📚 {t.get('course', 'Materia')}\n📅 {t.get('due_date_str', 'Sin fecha')}",
                    )
                    send_whatsapp_alert(
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="new",
                    )
                    storage.record_milestone(task_id, "new")

        # 2. Hitos por tiempo restante (8h, 1d, 2d, 3d)
        for t in tasks:
            task_id = str(t.get("id"))
            if t.get("status") == "submitted" or t.get("is_dismissed"):
                continue

            due = t.get("due_timestamp", 0)
            if not due or due <= now:
                continue

            remaining = due - now

            # Hito 8 horas (<= 8 * 3600 segundos = 28800s)
            if remaining <= 8 * 3600:
                if not storage.has_notified_milestone(task_id, "8h"):
                    send_windows_notification(
                        title="🚨 ¡URGENTE Moodle! (Menos de 8 horas)",
                        message=f"¡Faltan menos de 8 horas para entregar!\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    send_whatsapp_alert(
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="8h",
                        is_urgent=True,
                    )
                    storage.record_milestone(task_id, "8h")
                # Prevenir disparos retroactivos de hitos mayores
                storage.record_milestone(task_id, "1d")
                storage.record_milestone(task_id, "2d")
                storage.record_milestone(task_id, "3d")

            # Hito 1 día (<= 24 * 3600 segundos = 86400s)
            elif remaining <= 24 * 3600:
                if not storage.has_notified_milestone(task_id, "1d"):
                    send_windows_notification(
                        title="⚠️ Recordatorio Moodle (¡Falta 1 día!)",
                        message=f"¡Atención! Falta 1 día para entregar:\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    send_whatsapp_alert(
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="1d",
                        is_urgent=True,
                    )
                    storage.record_milestone(task_id, "1d")
                storage.record_milestone(task_id, "2d")
                storage.record_milestone(task_id, "3d")

            # Hito 2 días (<= 48 * 3600 segundos = 172800s)
            elif remaining <= 48 * 3600:
                if not storage.has_notified_milestone(task_id, "2d"):
                    send_windows_notification(
                        title="⏳ Recordatorio Moodle (Faltan 2 días)",
                        message=f"Quedan 2 días para entregar:\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    send_whatsapp_alert(
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="2d",
                    )
                    storage.record_milestone(task_id, "2d")
                storage.record_milestone(task_id, "3d")

            # Hito 3 días (<= 72 * 3600 segundos = 259200s)
            elif remaining <= 72 * 3600:
                if not storage.has_notified_milestone(task_id, "3d"):
                    send_windows_notification(
                        title="📅 Recordatorio Moodle (Faltan 3 días)",
                        message=f"Quedan 3 días para entregar:\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    send_whatsapp_alert(
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="3d",
                    )
                    storage.record_milestone(task_id, "3d")

    @staticmethod
    def notify_new_tasks(new_tasks: List[Dict], storage=None):
        """Método de compatibilidad hacia atrás."""
        if storage:
            TaskNotificationManager.process_milestones([], storage, new_tasks=new_tasks)

    @staticmethod
    def notify_urgent_tasks(tasks: List[Dict], storage=None):
        """Método de compatibilidad hacia atrás."""
        if storage:
            TaskNotificationManager.process_milestones(tasks, storage)
