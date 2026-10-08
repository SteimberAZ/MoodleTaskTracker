"""pkg-worker-data: the built-in (legacy) class schedule keeps its keys local and has no hardcoded topic."""
from datetime import datetime

import pytest

import class_schedule


class _Resp:
    def __init__(self, status=200):
        self.status_code = status
        self.text = ""


# ---- built-in class schedule -----------------------------------------------------------------------


class _RecordingStorage:
    def __init__(self):
        self.calls = []

    def has_notified_milestone(self, task_id, milestone):
        return False

    def record_milestone(self, task_id, milestone, mirror=True):
        self.calls.append((task_id, milestone, mirror))


def test_built_in_class_keys_stay_local(monkeypatch):
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 6, 6, 40, tzinfo=class_schedule.ECUADOR_TZ)  # Tuesday, 20 min before 07:00

    monkeypatch.setattr(class_schedule, "datetime", Frozen)
    monkeypatch.setattr(class_schedule, "send_class_notification", lambda c, minutes_left=30: True)
    storage = _RecordingStorage()
    class_schedule.check_and_notify_upcoming_classes(storage)
    assert storage.calls == [("class_desarrollo_web_mar_2026-10-06", "30m", False)]


def test_class_fallback_needs_an_explicit_topic(monkeypatch, capsys):
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    monkeypatch.setattr(class_schedule, "_missing_topic_logged", False)
    monkeypatch.setattr(class_schedule.requests, "post", lambda *a, **k: pytest.fail("no request expected"))
    class_schedule.send_class_notification(class_schedule.CLASS_SCHEDULE[0])
    class_schedule.send_class_notification(class_schedule.CLASS_SCHEDULE[0])
    assert capsys.readouterr().out.count("NTFY_TOPIC is not set") == 1


def test_class_fallback_uses_ntfy_server(monkeypatch):
    seen = []
    monkeypatch.setenv("NTFY_TOPIC", "my-topic")
    monkeypatch.setenv("NTFY_SERVER", "https://ntfy.example/")
    monkeypatch.setattr(class_schedule.requests, "post",
                        lambda url, data=None, headers=None, timeout=None: seen.append(url) or _Resp(200))
    class_schedule.send_class_notification(class_schedule.CLASS_SCHEDULE[0])
    assert seen == ["https://ntfy.example/my-topic"]
