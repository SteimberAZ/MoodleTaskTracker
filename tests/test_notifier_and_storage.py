import time

import notifier
from notifier import TaskNotificationManager
from storage import Storage


class _NoSupabase:
    is_configured = False


class FakeStorage:
    def __init__(self):
        self.recorded = set()

    def has_notified_milestone(self, task_id, milestone):
        return (task_id, milestone) in self.recorded

    def record_milestone(self, task_id, milestone):
        self.recorded.add((task_id, milestone))


def _capture(monkeypatch):
    sent = []
    monkeypatch.setattr(notifier, "send_windows_notification", lambda **k: sent.append(("win", k)))
    monkeypatch.setattr(notifier, "send_whatsapp_alert", lambda **k: sent.append(("push", k)))
    return sent


def _task(task_id="t1", status="pending", hours_left=5, **extra):
    t = {
        "id": task_id,
        "title": "Tarea",
        "course": "Curso",
        "due_date_str": "hoy",
        "due_timestamp": int(time.time()) + hours_left * 3600,
        "task_url": "https://m.example/mod/assign/view.php?id=1",
        "status": status,
    }
    t.update(extra)
    return t


def test_submitted_task_skips_all_milestones_including_new(monkeypatch):
    sent = _capture(monkeypatch)
    t = _task(status="submitted")
    TaskNotificationManager.process_milestones([t], FakeStorage(), new_tasks=[t])
    assert sent == []


def test_dismissed_task_skips_new_milestone(monkeypatch):
    sent = _capture(monkeypatch)
    t = _task(is_dismissed=1)
    TaskNotificationManager.process_milestones([t], FakeStorage(), new_tasks=[t])
    assert sent == []


def test_pending_task_still_notifies(monkeypatch):
    sent = _capture(monkeypatch)
    t = _task()
    TaskNotificationManager.process_milestones([t], FakeStorage(), new_tasks=[t])
    milestones = {k.get("milestone") for kind, k in sent if kind == "push"}
    assert milestones == {"new", "8h"}


def _storage(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _NoSupabase()
    return s


def test_submitted_is_sticky_against_calendar_heuristic(tmp_path):
    s = _storage(tmp_path)
    s.save_tasks([_task(status="submitted")])
    later = _task(status="pending")
    s.save_tasks([later])
    assert later["status"] == "submitted"
    assert s.get_all_tasks()[0]["status"] == "submitted"


def test_assignment_page_can_revert_submitted(tmp_path):
    s = _storage(tmp_path)
    s.save_tasks([_task(status="submitted")])
    s.save_tasks([_task(status="pending", status_source="assignment_page")])
    assert s.get_all_tasks()[0]["status"] == "pending"


def test_pending_can_become_submitted(tmp_path):
    s = _storage(tmp_path)
    s.save_tasks([_task(status="pending")])
    s.save_tasks([_task(status="submitted")])
    assert s.get_all_tasks()[0]["status"] == "submitted"


def test_ntfy_errors_never_log_the_full_topic(monkeypatch, capsys):
    import requests

    import notifier

    topic = "utm-secret-topic-1234567890"

    def down(url, **kwargs):
        raise requests.ConnectionError(f"HTTPSConnectionPool(host='ntfy.sh', port=443): Max retries exceeded "
                                       f"with url: /{topic}")

    class Inline:
        def __init__(self, target, daemon=None):
            self.target = target

        def start(self):
            self.target()

    monkeypatch.setattr(requests, "post", down)
    monkeypatch.setattr("threading.Thread", Inline)
    assert notifier.post_ntfy("T", "B", topic=topic) is False
    notifier.send_system_alert("T", "B", topic=topic)
    notifier.send_whatsapp_alert("T", "C", "hoy", topic=topic)

    class Refused:
        status_code, text = 403, f"forbidden: /{topic}"

    monkeypatch.setattr(requests, "post", lambda url, **kwargs: Refused())
    notifier.post_ntfy("T", "B", topic=topic)
    out = capsys.readouterr().out
    assert out.count("ConnectionError") == 3 and "403" in out
    assert topic not in out
