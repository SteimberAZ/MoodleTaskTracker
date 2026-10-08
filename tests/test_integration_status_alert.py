"""Status alerts key their retry state by title and ask the device to ring again (pkg-delivery-core contract)."""
from functools import partial

import api_sync


def test_status_alerts_pass_retry_key_and_renotify_when_the_deliverer_accepts_them():
    calls = []

    def deliver(user, title, body, url="/", tag="moodle", priority="default", ntfy_tags="bell", kind="task",
                renotify=False, retry_key=None, history=None):
        calls.append({"title": title, "tag": tag, "renotify": renotify, "retry_key": retry_key})
        return True

    alert = api_sync._user_alert(partial(deliver, history=object()), {"id": "u1"})
    alert(title="Moodle desconectado", message="m")
    alert(title="Moodle reconectado", message="m")
    assert calls == [
        {"title": "Moodle desconectado", "tag": "moodle-status", "renotify": True, "retry_key": "Moodle desconectado"},
        {"title": "Moodle reconectado", "tag": "moodle-status", "renotify": True, "retry_key": "Moodle reconectado"},
    ]


def test_status_alerts_keep_working_with_an_older_deliverer():
    calls = []

    def deliver(user, title, body, url="/", tag="moodle", priority="default", ntfy_tags="bell", kind="task"):
        calls.append(title)
        return True

    assert api_sync._user_alert(deliver, {"id": "u1"})(title="Moodle desconectado", message="m") is True
    assert calls == ["Moodle desconectado"]
