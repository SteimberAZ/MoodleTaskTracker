import os
import subprocess
import sys
from typing import Callable, Dict, List, Optional


def ntfy_base_url() -> str:
    """ntfy server base URL; NTFY_SERVER overrides the public ntfy.sh (e.g. a self-hosted/tunneled server)."""
    return (os.environ.get("NTFY_SERVER", "").strip() or "https://ntfy.sh").rstrip("/")


_missing_topic_logged = False


def default_topic() -> str:
    """Owner/legacy topic from env NTFY_TOPIC (used when a caller passes no per-user topic).

    There is no built-in fallback topic: topics are bearer secrets, so without NTFY_TOPIC the legacy
    path sends nothing (logged once).
    """
    return os.environ.get("NTFY_TOPIC", "").strip()


def _resolve_topic(topic: Optional[str]) -> str:
    """``topic`` or env NTFY_TOPIC; "" (logged once per process) when neither is set."""
    global _missing_topic_logged
    target = topic or default_topic()
    if not target and not _missing_topic_logged:
        _missing_topic_logged = True
        print("[Notifier] NTFY_TOPIC is not set and no per-user topic was given; ntfy is skipped.")
    return target


def mask_topic(topic: str) -> str:
    """Log-safe form of a topic: topics are bearer secrets, so only a short prefix is shown."""
    topic = topic or ""
    return f"{topic[:8]}…" if len(topic) > 8 else "…"


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


def send_system_alert(
    title: str,
    message: str,
    priority: str = "urgent",
    tags: str = "warning,rotating_light",
    click_url: str = "",
    topic: Optional[str] = None,
):
    """Envía una alerta de sistema o estado a ntfy (ej. sesión caducada, fallas de red).

    ``topic`` selects the destination (per user); None falls back to env NTFY_TOPIC.
    """
    target = _resolve_topic(topic)

    def _do_post():
        topic = target
        if not topic:
            return

        headers = {
            "Title": title,
            "Priority": priority,
            "Tags": tags,
            "Content-Type": "text/plain; charset=utf-8",
        }
        if click_url:
            headers["Click"] = click_url

        try:
            import requests
            res = requests.post(
                f"{ntfy_base_url()}/{topic}",
                data=message.encode("utf-8"),
                headers=headers,
                timeout=10,
            )
            if res.status_code == 200:
                print(f"[Notifier] Alerta de sistema enviada a {ntfy_base_url()}/{mask_topic(topic)}")
            else:
                print(f"[Notifier] Error ntfy ({res.status_code}): {res.text}")
        except Exception as e:
            print(f"[Notifier] Error enviando alerta a ntfy: {e}")

    import threading
    threading.Thread(target=_do_post, daemon=True).start()


def post_ntfy(
    title: str,
    message: str,
    priority: str = "default",
    tags: str = "bell",
    topic: Optional[str] = None,
    click: str = "",
) -> bool:
    """Synchronous ntfy push. Returns True when the server accepted it.

    ``topic`` selects the destination (per user); None falls back to env NTFY_TOPIC. ``click`` is an
    absolute URL opened when the notification is tapped (the ``Click`` header); empty sends none.
    """
    topic = _resolve_topic(topic)
    if not topic:
        return False
    headers = {
        # HTTP headers are latin-1; encode the UTF-8 bytes so non-ASCII titles do not raise.
        "Title": title.replace("\n", " ").encode("utf-8").decode("latin-1"),
        "Priority": priority,
        "Tags": tags,
        "Content-Type": "text/plain; charset=utf-8",
    }
    if click:
        headers["Click"] = click
    try:
        import requests
        res = requests.post(
            f"{ntfy_base_url()}/{topic}",
            data=message.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        if res.status_code == 200:
            print(f"[Notifier] Push enviado a {ntfy_base_url()}/{mask_topic(topic)}")
            return True
        print(f"[Notifier] Error ntfy ({res.status_code}): {res.text}")
    except Exception as e:
        print(f"[Notifier] Error enviando a ntfy: {e}")
    return False


def milestone_message(title: str, course: str, due_date: str, milestone: str = "new") -> Dict:
    """Header, ntfy priority/tags and body lines of one task alert (shared by ntfy and Web Push)."""
    priority = "default"
    tags = "mortarboard,books"
    header = "Nueva tarea en Moodle UTM"

    if milestone == "8h":
        priority = "urgent"
        tags = "rotating_light,warning,books"
        header = "URGENTE: Faltan menos de 8 horas"
    elif milestone == "1d":
        priority = "high"
        tags = "warning,books"
        header = "Recordatorio: Falta 1 dia"
    elif milestone == "2d":
        priority = "default"
        tags = "hourglass,books"
        header = "Recordatorio: Faltan 2 dias"
    elif milestone == "3d":
        priority = "default"
        tags = "calendar,books"
        header = "Recordatorio: Faltan 3 dias"

    lines = [
        f"📚 Materia: {course or 'General'}",
        f"📝 Tarea: {title}",
        f"📅 Límite: {due_date or 'Sin fecha'}",
    ]
    return {"header": header, "priority": priority, "tags": tags, "lines": lines}


def send_whatsapp_alert(
    title: str,
    course: str,
    due_date: str,
    task_url: str = "",
    milestone: str = "new",
    is_urgent: bool = False,
    topic: Optional[str] = None,
):
    """Envía la alerta directamente a la app móvil ntfy con sonido, prioridad y enlace directo.

    ``topic`` selects the destination (per user); None falls back to env NTFY_TOPIC.
    """
    target = _resolve_topic(topic)

    def _do_post():
        topic = target
        if not topic:
            return

        msg = milestone_message(
title, course, due_date, milestone)
        msg_lines = list(msg["lines"])
        if task_url:
            msg_lines.append(f"🔗 {task_url}")
        body = "\n".join(msg_lines)

        headers = {
            "Title": msg["header"],
            "Priority": msg["priority"],
            "Tags": msg["tags"],
            "Content-Type": "text/plain; charset=utf-8",
        }

        try:
            import requests
            res = requests.post(
                f"{ntfy_base_url()}/{topic}",
                data=body.encode("utf-8"),
                headers=headers,
                timeout=10,
            )
            if res.status_code == 200:
                print(f"[Notifier] Notificación Push enviada ({milestone}) a {ntfy_base_url()}/{mask_topic(topic)}")
            else:
                print(f"[Notifier] Error ntfy ({res.status_code}): {res.text}")
        except Exception as e:
            print(f"[Notifier] Error enviando a ntfy: {e}")

    import threading
    threading.Thread(target=_do_post, daemon=True).start()


def _retry_key(task_id: str, milestone: str) -> str:
    """Bounded-retry key of one task milestone (they share the push tag ``task-<id>``)."""
    return f"task-{task_id}:{milestone}"


def _bound_user_id(deliver) -> str:
    """User id of a deliverer bound with ``functools.partial(deliver_to_user, user)`` ("" otherwise)."""
    args = getattr(deliver, "args", None) or ()
    user = args[0] if args else None
    return str(user.get("id") or "") if isinstance(user, dict) else ""


class TaskNotificationManager:
    """Gestiona el análisis de tareas y el disparo de recordatorios según los 5 hitos configurados."""

    @staticmethod
    def process_milestones(
        tasks: List[Dict],
        storage,
        new_tasks: Optional[List[Dict]] = None,
        topic: Optional[str] = None,
        desktop: bool = True,
        deliver: Optional[Callable[..., bool]] = None,
    ):
        """
        ``topic``: ntfy topic that receives the pushes (None = env NTFY_TOPIC, the legacy owner).
        ``desktop``: also show a Windows toast; multi-user sync passes False because the machine
        running the worker belongs to the owner, not to the user whose tasks are processed.
        ``deliver``: per-user delivery (Web Push + optional ntfy), already bound to its user, called as
        ``deliver(title=, body=, url=, tag=, priority=, ntfy_tags=, ntfy_link=) -> bool``. When given it
        replaces the ntfy-only ``topic`` path, and a milestone is recorded only if it reports success, so
        a total delivery failure is retried on the next sync, until delivery.is_exhausted reports that
        the bounded retries of that milestone are used up (it is then recorded anyway; the history keeps
        its "failed" rows). Every milestone asks the device to alert again (``renotify``) because they
        share the task tag, and the 3d/2d/1d/8h alerts expire on the push service when the task is due.
        The 'new' alert is not sent for a task that is already overdue.

        Evalúa y envía los recordatorios para los 5 hitos:
        1. 'new': Tarea recién descubierta
        2. '3d': Faltan 3 días (<= 72 horas)
        3. '2d': Faltan 2 días (<= 48 horas)
        4. '1d': Falta 1 día (<= 24 horas)
        5. '8h': Faltan 8 horas (<= 8 horas)
        """
        import time

        import delivery  # imported here: delivery imports this module
        from webpush_sender import TTL_TASK

        now = int(time.time())
        bound_user = _bound_user_id(deliver)

        def _toast(**kwargs):
            if desktop:
                send_windows_notification(**kwargs)

        def _ttl(milestone: str, due) -> int:
            """Push TTL: a countdown alert is worthless once the task is due ('new' keeps TTL_TASK)."""
            if milestone == "new" or not due:
                return TTL_TASK
            return max(60, min(int(due) - now, TTL_TASK))

        def _push(task_id: str, due=None, **kwargs) -> bool:
            """Send one alert; False only when a per-user deliverer reported that nothing got through."""
            if deliver is None:
                send_whatsapp_alert(topic=topic, **kwargs)  # fire-and-forget on a thread: assume sent
                return True
            milestone = kwargs["milestone"]
            msg = milestone_message(kwargs["title"], kwargs["course"], kwargs["due_date"], milestone)
            return bool(
                deliver(
                    title=msg["header"],
                    body="\n".join(msg["lines"]),
                    url=f"/tareas/{task_id}",
                    tag=f"task-{task_id}",
                    priority=msg["priority"],
                    ntfy_tags=msg["tags"],
                    ntfy_link=kwargs.get("task_url", ""),
                    kind="task",
                    renotify=True,
                    ttl=_ttl(milestone, due),
                    retry_key=_retry_key(task_id, milestone),
                )
            )

        def _settle(t: Dict, task_id: str, milestone: str, delivered: bool) -> None:
            """Record the milestone when it was delivered, or when its bounded retries are exhausted."""
            if delivered:
                storage.record_milestone(task_id, milestone)
                return
            user_id = str(t.get("user_id") or bound_user or "")
            key = _retry_key(task_id, milestone)
            if deliver is not None and user_id and delivery.is_exhausted(user_id, "task", key):
                print(f"[Notifier] task {task_id[:12]} '{milestone}' alert not delivered after every retry; giving up.")
                storage.record_milestone(task_id, milestone)
                delivery.forget(user_id, "task", key)

        def _pre_record(task_id: str, *milestones: str) -> None:
            """Settle the larger milestones without re-recording (and re-mirroring) them every round."""
            for m in milestones:
                if not storage.has_notified_milestone(task_id, m):
                    storage.record_milestone(task_id, m)

        # 1. Hito 'new' para tareas recién detectadas
        if new_tasks:
            for t in new_tasks:
                task_id = str(t.get("id"))
                if t.get("status") == "submitted" or t.get("is_dismissed"):
                    # Nothing to announce: settle it so a later unmute does not alert it as "new".
                    if not storage.has_notified_milestone(task_id, "new"):
                        storage.record_milestone(task_id, "new")
                    continue
                new_due = t.get("due_timestamp") or 0
                if new_due and new_due <= now:
                    continue  # already overdue: announcing it as new would be noise
                if not storage.has_notified_milestone(task_id, "new"):
                    _toast(
                        title="🔔 ¡Nueva tarea agregada en Moodle!",
                        message=f"{t.get('title', 'Sin título')}\n📚 {t.get('course', 'Materia')}\n📅 {t.get('due_date_str', 'Sin fecha')}",
                    )
                    ok = _push(
                        task_id,
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="new",
                    )
                    _settle(t, task_id, "new", ok)

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
                    _toast(
                        title="🚨 ¡URGENTE Moodle! (Menos de 8 horas)",
                        message=f"¡Faltan menos de 8 horas para entregar!\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    ok = _push(
                        task_id,
                        due=due,
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="8h",
                        is_urgent=True,
                    )
                    _settle(t, task_id, "8h", ok)
                # Prevenir disparos retroactivos de hitos mayores
                _pre_record(task_id, "1d", "2d", "3d")

            # Hito 1 día (<= 24 * 3600 segundos = 86400s)
            elif remaining <= 24 * 3600:
                if not storage.has_notified_milestone(task_id, "1d"):
                    _toast(
                        title="⚠️ Recordatorio Moodle (¡Falta 1 día!)",
                        message=f"¡Atención! Falta 1 día para entregar:\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    ok = _push(
                        task_id,
                        due=due,
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="1d",
                        is_urgent=True,
                    )
                    _settle(t, task_id, "1d", ok)
                _pre_record(task_id, "2d", "3d")

            # Hito 2 días (<= 48 * 3600 segundos = 172800s)
            elif remaining <= 48 * 3600:
                if not storage.has_notified_milestone(task_id, "2d"):
                    _toast(
                        title="⏳ Recordatorio Moodle (Faltan 2 días)",
                        message=f"Quedan 2 días para entregar:\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    ok = _push(
                        task_id,
                        due=due,
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="2d",
                    )
                    _settle(t, task_id, "2d", ok)
                _pre_record(task_id, "3d")

            # Hito 3 días (<= 72 * 3600 segundos = 259200s)
            elif remaining <= 72 * 3600:
                if not storage.has_notified_milestone(task_id, "3d"):
                    _toast(
                        title="📅 Recordatorio Moodle (Faltan 3 días)",
                        message=f"Quedan 3 días para entregar:\n{t.get('title', '')}\n📚 {t.get('course', '')}\n📅 {t.get('due_date_str', '')}",
                    )
                    ok = _push(
                        task_id,
                        due=due,
                        title=t.get("title", ""),
                        course=t.get("course", ""),
                        due_date=t.get("due_date_str", ""),
                        task_url=t.get("task_url", ""),
                        milestone="3d",
                    )
                    _settle(t, task_id, "3d", ok)

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
