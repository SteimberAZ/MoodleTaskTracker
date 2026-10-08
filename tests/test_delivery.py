"""Unified delivery: Web Push + optional ntfy per user, and every notification type that uses it."""
import time
from datetime import datetime, timezone

import pytest

import api_sync
import class_schedule
import delivery
import notifier
import supabase_client
import worker
from custom_reminders import process_due_reminders
from delivery import deliver_to_user, process_push_tests, urgency_for
from moodle_api import MoodleTokenInvalid, event_to_task, make_task_id
from storage import Storage
from supabase_client import SupabaseClient
from webpush_sender import TTL_CLASS, TTL_REMINDER, TTL_TASK, TTL_TEST, PushResult

BASE = "https://m.example"
URL_1 = f"{BASE}/mod/assign/view.php?id=11"
UA = {"id": "11111111-aaaa-bbbb-cccc-000000000001", "moodle_url": BASE, "token": "tok-a",
      "ntfy_topic": "utm-aaaaaaaaaaaa", "ntfy_enabled": True, "last_error": None}
UB = {"id": "22222222-aaaa-bbbb-cccc-000000000002", "moodle_url": BASE, "token": "tok-b",
      "ntfy_topic": "utm-bbbbbbbbbbbb", "ntfy_enabled": True, "last_error": None}


@pytest.fixture(autouse=True)
def _fresh_log_state(monkeypatch):
    monkeypatch.delenv("WEB_APP_URL", raising=False)
    delivery._last_logged.clear()
    yield
    delivery._last_logged.clear()


# ---- fakes -------------------------------------------------------------------------------------------


def _subs(*names):
    return [{"id": f"s-{n}", "endpoint": f"https://push.example/{n}", "p256dh": "k", "auth": "a",
             "failure_count": 0} for n in names]


class FakeSender:
    """Stands in for WebPushSender: answers per endpoint (OK by default) and records every send."""

    def __init__(self, results=None, enabled=True, boom=()):
        self.enabled, self.results, self.boom, self.sent = enabled, results or {}, set(boom), []

    def send_push(self, sub, payload, ttl, urgency):
        self.sent.append({"endpoint": sub["endpoint"], "payload": payload, "ttl": ttl, "urgency": urgency})
        if sub["endpoint"] in self.boom:
            raise RuntimeError("boom")
        return self.results.get(sub["endpoint"], PushResult.OK)


class FakeDb:
    is_configured = True

    def __init__(self, subs=None, tests=None, admins=None, fail=False):
        self.subs, self.tests, self.admins, self.fail = subs or {}, tests or [], admins or [], fail
        self.reads, self.updates, self.clears = [], [], []

    def fetch_push_subscriptions(self, user_id):
        self.reads.append(user_id)
        if self.fail:
            raise RuntimeError("HTTP 503")
        return [dict(s) for s in self.subs.get(user_id, [])]

    def fetch_push_test_requests(self):
        self.reads.append("tests")
        if self.fail:
            raise RuntimeError("HTTP 503")
        return [dict(t) for t in self.tests]

    def fetch_admin_users(self):
        if self.fail:
            raise RuntimeError("HTTP 503")
        return list(self.admins)

    def update_push_subscription(self, sub_id, fields):
        self.updates.append((sub_id, fields))
        return True

    clear_ok = True

    def clear_push_test_request(self, sub_id, requested_at):
        self.updates.append((sub_id, {"test_requested_at": None}))
        self.clears.append((sub_id, requested_at))
        return self.clear_ok


class Ntfy:
    """Replaces notifier.post_ntfy."""

    def __init__(self, ok=True):
        self.ok, self.calls = ok, []

    def __call__(self, title, message, priority="default", tags="bell", topic=None):
        self.calls.append({"title": title, "message": message, "priority": priority, "tags": tags, "topic": topic})
        return self.ok


class Deliverer:
    """Records what deliver_to_user would receive, and answers with a fixed result."""

    def __init__(self, result=True):
        self.result, self.calls = result, []

    def __call__(self, user, title, body, url="/", tag="moodle", priority="default", **kw):
        self.calls.append(dict(user=user["id"], title=title, body=body, url=url, tag=tag, priority=priority, **kw))
        return self.result


def _deliver(user=UA, sender=None, db=None, ntfy=None, **kw):
    return deliver_to_user(user, "Titulo", "Cuerpo", url="/tareas/t1", tag="task-t1", priority="high",
                           supabase=db, sender=sender, ntfy=ntfy, **kw)


# ---- deliver_to_user ---------------------------------------------------------------------------------


def test_delivers_to_every_subscription_and_to_ntfy():
    db = FakeDb({UA["id"]: _subs("a", "b", "c")})
    sender, ntfy = FakeSender(), Ntfy()

    assert _deliver(sender=sender, db=db, ntfy=ntfy) is True

    assert [s["endpoint"] for s in sender.sent] == [f"https://push.example/{n}" for n in "abc"]
    first = sender.sent[0]
    # No history here, so there is no entry to point at: a tap opens plain Avisos; the page rides as target.
    assert first["payload"] == {"title": "Titulo", "body": "Cuerpo", "url": "/notificaciones",
                                "target": "/tareas/t1", "tag": "task-t1"}
    assert first["ttl"] == TTL_TASK and first["urgency"] == "high"
    assert ntfy.calls == [
        {"title": "Titulo", "message": "Cuerpo", "priority": "high", "tags": "bell", "topic": UA["ntfy_topic"]}
    ]


def test_ttl_and_ntfy_shaping_are_passed_through():
    db = FakeDb({UA["id"]: _subs("a")})
    sender, ntfy = FakeSender(), Ntfy()
    _deliver(sender=sender, db=db, ntfy=ntfy, ttl=TTL_REMINDER, ntfy_tags="alarm_clock,bell",
             ntfy_link="https://m.example/mod/assign/view.php?id=1")
    assert sender.sent[0]["ttl"] == TTL_REMINDER
    assert sender.sent[0]["payload"]["body"] == "Cuerpo"  # the Moodle link is only appended to the ntfy copy
    assert ntfy.calls[0]["tags"] == "alarm_clock,bell"
    assert ntfy.calls[0]["message"] == "Cuerpo\n🔗 https://m.example/mod/assign/view.php?id=1"


def test_ntfy_only_goes_out_when_the_user_has_it_enabled():
    db = FakeDb({UA["id"]: _subs("a")})
    off, ntfy = FakeSender(), Ntfy()
    assert _deliver(user=dict(UA, ntfy_enabled=False), sender=off, db=db, ntfy=ntfy) is True
    assert ntfy.calls == [] and len(off.sent) == 1  # push still goes out

    legacy_row = {k: v for k, v in UA.items() if k != "ntfy_enabled"}  # column not migrated yet
    assert _deliver(user=legacy_row, sender=FakeSender(), db=db, ntfy=ntfy) is True
    assert len(ntfy.calls) == 1


def test_a_user_without_a_topic_is_never_routed_to_the_owners_topic(monkeypatch):
    posted = []
    monkeypatch.setattr(notifier, "post_ntfy", lambda *a, **k: posted.append((a, k)) or True)
    assert _deliver(user=dict(UA, ntfy_topic=""), sender=None, db=None) is False
    assert posted == []


def test_the_default_ntfy_sender_is_notifier_post_ntfy(monkeypatch):
    ntfy = Ntfy()
    monkeypatch.setattr(notifier, "post_ntfy", ntfy)  # resolved at call time, so it can be replaced
    assert _deliver(sender=None, db=None) is True
    assert ntfy.calls[0]["topic"] == UA["ntfy_topic"]


@pytest.mark.parametrize("push, ntfy_ok, expected", [
    ([PushResult.OK], None, True),
    ([PushResult.FAILED, PushResult.OK], None, True),  # one good subscription is enough
    ([PushResult.FAILED, PushResult.GONE], True, True),  # ntfy rescues a dead push
    ([PushResult.OK], False, True),  # push rescues a failing ntfy
    ([PushResult.FAILED], False, False),
    ([PushResult.GONE], None, False),
    ([], None, False),  # no channel at all
    ([], True, True),  # only ntfy
])
def test_delivered_means_at_least_one_channel_accepted(push, ntfy_ok, expected):
    names = "abcdef"[: len(push)]
    db = FakeDb({UA["id"]: _subs(*names)})
    sender = FakeSender({f"https://push.example/{n}": r for n, r in zip(names, push)})
    ntfy = Ntfy(ok=bool(ntfy_ok))
    user = dict(UA, ntfy_enabled=ntfy_ok is not None)
    assert _deliver(user=user, sender=sender, db=db, ntfy=ntfy) is expected
    assert len(sender.sent) == len(push)


def test_without_a_working_sender_ntfy_still_delivers_and_the_database_is_not_queried():
    db = FakeDb({UA["id"]: _subs("a")})
    ntfy = Ntfy()
    assert _deliver(sender=FakeSender(enabled=False), db=db, ntfy=ntfy) is True
    assert _deliver(sender=None, db=db, ntfy=ntfy) is True
    assert db.reads == [] and len(ntfy.calls) == 2


def test_unreadable_subscriptions_do_not_block_ntfy_and_are_logged_once(capsys):
    db = FakeDb(fail=True)
    ntfy = Ntfy()
    assert _deliver(sender=FakeSender(), db=db, ntfy=ntfy) is True
    assert _deliver(sender=FakeSender(), db=db, ntfy=ntfy) is True
    assert capsys.readouterr().out.count("could not read push subscriptions") == 1
    assert len(ntfy.calls) == 2


def test_a_crashing_channel_never_stops_the_others():
    db = FakeDb({UA["id"]: _subs("a", "b")})
    sender = FakeSender(boom={"https://push.example/a"})
    assert _deliver(sender=sender, db=db, ntfy=Ntfy()) is True
    assert len(sender.sent) == 2  # b was still tried after a blew up

    def exploding(*a, **k):
        raise RuntimeError("ntfy down")

    assert _deliver(sender=FakeSender(), db=db, ntfy=exploding) is True  # push got through
    assert _deliver(sender=None, db=None, ntfy=exploding) is False


def test_a_user_without_an_id_gets_no_push_attempts():
    db = FakeDb()
    sender, ntfy = FakeSender(), Ntfy()
    assert _deliver(user={"ntfy_topic": "utm-x"}, sender=sender, db=db, ntfy=ntfy) is True
    assert db.reads == [] and sender.sent == []


@pytest.mark.parametrize("priority, urgency", [
    ("urgent", "high"), ("high", "high"), ("max", "high"), ("URGENT", "high"),
    ("default", "normal"), ("low", "normal"), ("", "normal"), (None, "normal"),
])
def test_priority_maps_to_the_web_push_urgency(priority, urgency):
    assert urgency_for(priority) == urgency


# ---- push test requests ------------------------------------------------------------------------------


def _test_row(n, user="uuuuuuuu-1"):
    return {"id": f"s-{n}", "user_id": user, "endpoint": f"https://push.example/{n}", "p256dh": "k", "auth": "a",
            "failure_count": 0}


def test_test_requests_get_the_fixed_message_and_the_flag_is_cleared():
    db = FakeDb(tests=[_test_row("a"), _test_row("b")])
    sender = FakeSender()
    assert process_push_tests(db, sender) == 2
    for sent in sender.sent:
        assert sent["payload"] == {"title": "Notificaciones activas ✅",
                                   "body": "Así te llegarán tus avisos de Moodle",
                                   "url": "/notificaciones", "target": "/notificaciones", "tag": "test"}
        assert sent["ttl"] == TTL_TEST == 600 and sent["urgency"] == "high"
    assert db.updates == [("s-a", {"test_requested_at": None}), ("s-b", {"test_requested_at": None})]


def test_a_failed_test_still_clears_the_flag_so_it_cannot_loop():
    db = FakeDb(tests=[_test_row("a"), _test_row("b")])
    sender = FakeSender({"https://push.example/a": PushResult.FAILED})
    assert process_push_tests(db, sender) == 1  # only the accepted one counts
    assert ("s-a", {"test_requested_at": None}) in db.updates


def test_a_gone_subscription_has_nothing_left_to_clear():
    db = FakeDb(tests=[_test_row("a")])
    assert process_push_tests(db, FakeSender({"https://push.example/a": PushResult.GONE})) == 0
    assert db.updates == []


def test_a_crashing_send_still_clears_the_flag_and_the_rest_continue():
    db = FakeDb(tests=[_test_row("a"), _test_row("b")])
    sender = FakeSender(boom={"https://push.example/a"})
    assert process_push_tests(db, sender) == 1
    assert [u[0] for u in db.updates] == ["s-a", "s-b"]


def test_test_requests_are_ignored_without_a_working_sender_or_database():
    db = FakeDb(tests=[_test_row("a")])
    assert process_push_tests(db, FakeSender(enabled=False)) == 0
    assert process_push_tests(db, None) == 0
    unconfigured = FakeDb(tests=[_test_row("a")])
    unconfigured.is_configured = False
    assert process_push_tests(unconfigured, FakeSender()) == 0
    assert db.reads == [] and unconfigured.reads == [] and db.updates == []


def test_the_clear_only_matches_the_request_that_was_read():
    db = FakeDb(tests=[dict(_test_row("a"), test_requested_at="2026-10-08T12:00:00.5+00:00")])
    assert process_push_tests(db, FakeSender(), answered=set()) == 1
    assert db.clears == [("s-a", "2026-10-08T12:00:00.5+00:00")]


def test_a_failed_clear_is_retried_without_sending_the_test_again():
    requested = "2026-10-08T12:00:00+00:00"
    db = FakeDb(tests=[dict(_test_row("a"), test_requested_at=requested)])
    db.clear_ok = False
    sender, answered = FakeSender(), set()
    assert process_push_tests(db, sender, answered=answered) == 1
    assert process_push_tests(db, sender, answered=answered) == 0
    assert process_push_tests(db, sender, answered=answered) == 0
    assert len(sender.sent) == 1 and len(db.clears) == 3  # one test, the clear retried every tick

    db.clear_ok = True
    process_push_tests(db, sender, answered=answered)
    assert answered == set() and len(sender.sent) == 1

    # A newer press (another timestamp) is a new request and gets its own test.
    db.tests = [dict(_test_row("a"), test_requested_at="2026-10-08T12:05:00+00:00")]
    assert process_push_tests(db, sender, answered=answered) == 1
    assert len(sender.sent) == 2


def test_clear_push_test_request_filters_on_the_value_read(monkeypatch):
    seen = {}

    def fake_patch(url, params=None, json=None, headers=None, timeout=None):
        seen.update(params=params, json=json)
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "patch", fake_patch)
    assert _client().clear_push_test_request("s1", "2026-10-08T12:00:00+00:00") is True
    assert seen == {"params": {"id": "eq.s1", "test_requested_at": "eq.2026-10-08T12:00:00+00:00"},
                    "json": {"test_requested_at": None}}
    monkeypatch.setattr(supabase_client.requests, "patch", lambda *a, **k: _Resp(503))
    assert _client().clear_push_test_request("s1", "x") is False


def test_unreadable_test_requests_are_logged_once_and_never_raise(capsys):
    db = FakeDb(fail=True)
    assert process_push_tests(db, FakeSender()) == 0
    assert process_push_tests(db, FakeSender()) == 0
    assert capsys.readouterr().out.count("could not read push test requests") == 1


# ---- task milestones ---------------------------------------------------------------------------------


class FakeStorage:
    def __init__(self):
        self.recorded = set()

    def has_notified_milestone(self, task_id, milestone):
        return (task_id, milestone) in self.recorded

    def record_milestone(self, task_id, milestone):
        self.recorded.add((task_id, milestone))


def _task(task_id="t1", hours_left=5, **extra):
    t = {"id": task_id, "title": "Tarea", "course": "Curso", "due_date_str": "hoy",
         "due_timestamp": int(time.time()) + hours_left * 3600,
         "task_url": "https://m.example/mod/assign/view.php?id=1", "status": "pending"}
    t.update(extra)
    return t


@pytest.fixture
def no_ntfy_only_path(monkeypatch):
    """With a per-user deliverer the ntfy-only senders and the desktop toast must stay untouched."""

    def forbidden(**k):
        raise AssertionError("ntfy-only sender used")

    monkeypatch.setattr(notifier, "send_whatsapp_alert", forbidden)
    monkeypatch.setattr(notifier, "send_windows_notification", forbidden)


def test_milestone_alerts_reach_the_deliverer_with_a_task_deep_link(no_ntfy_only_path):
    calls, storage, t = [], FakeStorage(), _task()
    notifier.TaskNotificationManager.process_milestones(
        [t], storage, new_tasks=[t], desktop=False, deliver=lambda **k: calls.append(k) or True
    )
    assert [(c["title"], c["priority"], c["ntfy_tags"]) for c in calls] == [
        ("Nueva tarea en Moodle UTM", "default", "mortarboard,books"),
        ("URGENTE: Faltan menos de 8 horas", "urgent", "rotating_light,warning,books"),
    ]
    for c in calls:
        assert c["url"] == "/tareas/t1" and c["tag"] == "task-t1"
        assert c["body"] == "📚 Materia: Curso\n📝 Tarea: Tarea\n📅 Límite: hoy"
        assert c["ntfy_link"] == "https://m.example/mod/assign/view.php?id=1"
    assert storage.recorded == {("t1", m) for m in ("new", "8h", "1d", "2d", "3d")}


# hours left, milestone, header, priority, milestones recorded even when nothing is delivered
WINDOWS = [
    (5, "8h", "URGENTE: Faltan menos de 8 horas", "urgent", {"1d", "2d", "3d"}),
    (20, "1d", "Recordatorio: Falta 1 dia", "high", {"2d", "3d"}),
    (40, "2d", "Recordatorio: Faltan 2 dias", "default", {"3d"}),
    (70, "3d", "Recordatorio: Faltan 3 dias", "default", set()),
]


@pytest.mark.parametrize("hours, milestone, header, priority, larger", WINDOWS)
def test_a_total_delivery_failure_leaves_the_milestone_for_the_next_sync(
    hours, milestone, header, priority, larger, no_ntfy_only_path
):
    storage, t = FakeStorage(), _task(hours_left=hours)
    process = notifier.TaskNotificationManager.process_milestones

    process([t], storage, desktop=False, deliver=lambda **k: False)
    assert storage.recorded == {("t1", m) for m in larger}  # bigger milestones stay suppressed

    calls = []
    process([t], storage, desktop=False, deliver=lambda **k: calls.append(k) or True)
    assert [(c["title"], c["priority"]) for c in calls] == [(header, priority)]
    assert ("t1", milestone) in storage.recorded

    process([t], storage, desktop=False, deliver=lambda **k: calls.append(k) or True)
    assert len(calls) == 1  # delivered once, not again


def test_muted_and_submitted_tasks_reach_nobody(no_ntfy_only_path):
    calls = []
    tasks = [_task("m", is_dismissed=1), _task("s", status="submitted")]
    notifier.TaskNotificationManager.process_milestones(
        tasks, FakeStorage(), new_tasks=tasks, desktop=False, deliver=lambda **k: calls.append(k) or True
    )
    assert calls == []


# ---- per-user sync -----------------------------------------------------------------------------------


class _NoSupabase:
    is_configured = False


class FakeUserSupabase:
    is_configured = True

    def __init__(self):
        self.updates = []

    def update_user(self, user_id, fields):
        self.updates.append((user_id, fields))
        return True


def _event(url, hours=5):
    return {"id": 1, "name": "Tarea", "modulename": "assign", "instance": 9,
            "timesort": int(time.time()) + hours * 3600, "url": url,
            "course": {"fullname": "Fisica"}, "action": {"actionable": True, "url": url}}


class EventClient:
    def __init__(self, user_id, events=None, exc=None):
        self.user_id, self.events, self.exc = user_id, events or [], exc

    def fetch_tasks(self):
        if self.exc:
            raise self.exc
        return [event_to_task(e, BASE, user_id=self.user_id) for e in self.events]


def _storage(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _NoSupabase()
    return s


def test_each_users_milestones_go_to_that_users_channels(tmp_path, no_ntfy_only_path):
    s, deliver = _storage(tmp_path), Deliverer()
    out = worker.sync_all_users(
        s, _NoSupabase(), [UA, UB],
        client_factory=lambda u: EventClient(u["id"], [_event(URL_1, hours=5)]), deliver=deliver,
    )
    assert out == {UA["id"]: "ok", UB["id"]: "ok"}
    # first sync: the guard suppresses 'new', the <8h milestone fires once per user
    assert sorted((c["user"], c["priority"], c["tag"], c["url"]) for c in deliver.calls) == sorted(
        (u["id"], "urgent", f"task-{make_task_id(URL_1, u['id'])}", f"/tareas/{make_task_id(URL_1, u['id'])}")
        for u in (UA, UB)
    )


def test_disconnected_alert_goes_through_the_deliverer_once(tmp_path):
    s, deliver = _storage(tmp_path), Deliverer()
    bad = MoodleTokenInvalid("bad token", code="invalidtoken")
    for _ in range(3):
        out = api_sync.sync_user_via_api(s, UA, FakeUserSupabase(), client=EventClient(UA["id"], exc=bad), deliver=deliver)
        assert out == "invalid"
    assert len(deliver.calls) == 1  # deduplicated across syncs
    c = deliver.calls[0]
    assert (c["user"], c["title"], c["body"]) == (UA["id"], "Moodle desconectado",
                                                   "Moodle desconectado: vuelve a iniciar sesión en la web")
    assert (c["url"], c["tag"], c["priority"], c["ntfy_tags"]) == ("/", "moodle-status", "urgent", "warning,rotating_light")


def test_an_undelivered_disconnected_alert_is_retried_until_it_gets_through(tmp_path):
    s, deliver = _storage(tmp_path), Deliverer(result=False)
    bad = MoodleTokenInvalid("bad token", code="invalidtoken")
    key = api_sync.alert_setting_key(UA["id"])

    def sync():
        api_sync.sync_user_via_api(s, UA, FakeUserSupabase(), client=EventClient(UA["id"], exc=bad), deliver=deliver)

    sync()
    sync()
    assert len(deliver.calls) == 2 and s.get_setting(key, "") == ""  # nothing recorded: tried again
    deliver.result = True
    sync()
    assert len(deliver.calls) == 3 and s.get_setting(key, "") != ""
    sync()
    assert len(deliver.calls) == 3


def test_reconnection_notice_uses_the_deliverer_too(tmp_path):
    s, deliver = _storage(tmp_path), Deliverer()
    sb = FakeUserSupabase()
    bad = MoodleTokenInvalid("bad", code="invalidtoken")
    api_sync.sync_user_via_api(s, UA, sb, client=EventClient(UA["id"], exc=bad), deliver=deliver)
    api_sync.sync_user_via_api(s, UA, sb, client=EventClient(UA["id"], []), process=lambda *a, **k: None, deliver=deliver)
    c = deliver.calls[-1]
    assert (c["title"], c["priority"], c["ntfy_tags"], c["tag"]) == (
        "Moodle reconectado", "default", "white_check_mark,mortarboard", "moodle-status")


def test_an_injected_alert_still_wins_over_the_deliverer(tmp_path):
    s, deliver, alerts = _storage(tmp_path), Deliverer(), []
    bad = MoodleTokenInvalid("bad", code="invalidtoken")
    api_sync.sync_user_via_api(s, UA, FakeUserSupabase(), client=EventClient(UA["id"], exc=bad),
                               alert=lambda **k: alerts.append(k), deliver=deliver)
    assert len(alerts) == 1 and deliver.calls == []


def test_run_task_tick_hands_the_deliverer_to_the_user_sync(monkeypatch):
    seen = {}

    class Users:
        def fetch_active_users(self):
            return [UA]

    monkeypatch.setattr(worker, "sync_all_users", lambda *a, **k: seen.update(k) or {})
    deliver = object()
    assert worker.run_task_tick(None, Users(), deliver=deliver) == "users"
    assert seen["deliver"] is deliver


# ---- custom reminders --------------------------------------------------------------------------------

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


def _reminder(**over):
    r = {"id": "r1", "title": "Drink water", "message": None, "interval_minutes": 60,
         "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-01-02T00:00:00Z",
         "next_fire_at": "2026-01-01T11:59:00Z", "active": True, "user_id": "u1",
         "moodle_users": {"ntfy_topic": "utm-owner1", "active": True}}
    r.update(over)
    return r


class FakeReminders:
    is_configured = True

    def __init__(self, rows):
        self.rows, self.updates = rows, []

    def fetch_due_reminders(self, now_iso):
        return self.rows

    def update_reminder(self, rid, fields):
        self.updates.append((rid, fields))
        return True


def test_reminders_are_delivered_to_the_owner_user_row():
    client = FakeReminders([_reminder(moodle_users={"ntfy_topic": "utm-owner1", "active": True, "ntfy_enabled": False})])
    seen = []
    n = process_due_reminders(
        client, deliver=lambda owner, rem, title, body: seen.append((owner, rem["id"], title, body)) or True, now=NOW
    )
    assert n == 1
    assert seen == [({"id": "u1", "ntfy_topic": "utm-owner1", "ntfy_enabled": False}, "r1", "Drink water", "Drink water")]
    assert client.updates[0][0] == "r1"


def test_a_missing_ntfy_enabled_column_means_on():
    seen = []
    process_due_reminders(FakeReminders([_reminder()]),
                          deliver=lambda owner, *a: seen.append(owner["ntfy_enabled"]) or True, now=NOW)
    assert seen == [True]


def test_an_undelivered_reminder_stays_untouched_for_the_next_tick():
    client = FakeReminders([_reminder()])
    assert process_due_reminders(client, deliver=lambda *a: False, now=NOW) == 0
    assert client.updates == []


def test_reminders_without_an_active_owner_never_reach_the_deliverer():
    rows = [_reminder(user_id=None, moodle_users=None),
            _reminder(moodle_users={"ntfy_topic": "utm-z", "active": False}),
            _reminder(moodle_users={"ntfy_topic": "", "active": True})]
    seen = []
    assert process_due_reminders(FakeReminders(rows), deliver=lambda *a: seen.append(a) or True, now=NOW) == 0
    assert seen == []


def test_a_sender_or_a_deliverer_is_required():
    with pytest.raises(ValueError):
        process_due_reminders(FakeReminders([]), now=NOW)


def test_the_worker_adapter_builds_the_reminder_notification():
    calls = []
    send = worker.reminder_deliverer(lambda user, title, body, **kw: calls.append((user, title, body, kw)) or True)
    owner = {"id": "u1", "ntfy_topic": "utm-owner1", "ntfy_enabled": True}
    assert send(owner, {"id": "r9"}, "Beber agua", "Ahora") is True
    assert calls == [(owner, "Beber agua", "Ahora", {
        "url": "/", "tag": "reminder-r9", "priority": "high", "ttl": TTL_REMINDER, "ntfy_tags": "alarm_clock,bell",
        "kind": "reminder", "renotify": True})]


# ---- class reminders (owner only) ---------------------------------------------------------------------

# A Tuesday, 06:40 in Ecuador: DESARROLLO DE APLICACIONES WEB starts at 07:00.
MOMENT = datetime(2026, 10, 6, 6, 40, tzinfo=class_schedule.ECUADOR_TZ)
CLASS_KEY = ("class_desarrollo_web_mar_2026-10-06", "30m")
ADMINS = [{"id": "adm1", "ntfy_topic": "utm-adm1", "ntfy_enabled": True},
          {"id": "adm2", "ntfy_topic": "utm-adm2", "ntfy_enabled": False}]


@pytest.fixture
def class_clock(monkeypatch):
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return MOMENT

    assert MOMENT.weekday() == 1
    monkeypatch.setattr(class_schedule, "datetime", Frozen)


@pytest.fixture
def legacy_class_sends(monkeypatch):
    sent = []
    monkeypatch.setattr(class_schedule, "send_class_notification", lambda c, minutes_left=30: sent.append(c["id"]))
    return sent


def test_class_reminders_go_to_every_admin_user(class_clock, legacy_class_sends):
    storage, deliver = FakeStorage(), Deliverer()
    class_schedule.check_and_notify_upcoming_classes(storage, supabase=FakeDb(admins=ADMINS), deliver=deliver)

    assert [c["user"] for c in deliver.calls] == ["adm1", "adm2"]
    c = deliver.calls[0]
    assert c["title"] == "Proxima clase en 20 min: DESARROLLO DE APLICACIONES WEB"
    assert "Aula: 1-59-1-03-LC" in c["body"] and "Docente: PARRAGA VALLE JOSE EDUARDO" in c["body"]
    assert (c["url"], c["tag"], c["priority"], c["ttl"]) == ("/", "class-desarrollo_web_mar", "high", TTL_CLASS)
    assert c["ntfy_tags"] == "alarm_clock,mortarboard,books"
    assert legacy_class_sends == []
    assert storage.recorded == {CLASS_KEY}

    class_schedule.check_and_notify_upcoming_classes(storage, supabase=FakeDb(admins=ADMINS), deliver=deliver)
    assert len(deliver.calls) == 2  # already notified today


def _db(**kw):
    return FakeDb(**kw)


def _unconfigured():
    db = FakeDb(admins=ADMINS)
    db.is_configured = False
    return db


@pytest.mark.parametrize("make_db, use_deliver", [
    (lambda: _db(admins=[]), True),  # no admin user exists
    (lambda: _db(fail=True), True),  # Supabase unavailable
    (_unconfigured, True),  # no database configured
    (lambda: _db(admins=ADMINS), False),  # legacy caller without a deliverer
], ids=["no-admin", "db-down", "unconfigured", "no-deliverer"])
def test_class_reminders_fall_back_to_the_env_topic(class_clock, legacy_class_sends, make_db, use_deliver):
    storage, deliver = FakeStorage(), Deliverer()
    class_schedule.check_and_notify_upcoming_classes(
        storage, supabase=make_db(), deliver=deliver if use_deliver else None
    )
    assert legacy_class_sends == ["desarrollo_web_mar"] and deliver.calls == []
    assert storage.recorded == {CLASS_KEY}


def test_legacy_signature_without_arguments_still_works(class_clock, legacy_class_sends):
    storage = FakeStorage()
    class_schedule.check_and_notify_upcoming_classes(storage)
    assert legacy_class_sends == ["desarrollo_web_mar"] and storage.recorded == {CLASS_KEY}


def test_a_total_failure_is_retried_on_the_next_tick(class_clock, legacy_class_sends):
    storage, deliver, db = FakeStorage(), Deliverer(result=False), FakeDb(admins=ADMINS[:1])
    class_schedule.check_and_notify_upcoming_classes(storage, supabase=db, deliver=deliver)
    assert storage.recorded == set() and len(deliver.calls) == 1

    deliver.result = True
    class_schedule.check_and_notify_upcoming_classes(storage, supabase=db, deliver=deliver)
    assert storage.recorded == {CLASS_KEY} and len(deliver.calls) == 2

    class_schedule.check_and_notify_upcoming_classes(storage, supabase=db, deliver=deliver)
    assert len(deliver.calls) == 2


# ---- Supabase REST shapes ----------------------------------------------------------------------------


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code, self._payload, self.text = status, payload if payload is not None else [], text

    def json(self):
        return self._payload


def _client():
    return SupabaseClient(url="https://sb.example", key="k")


def test_fetch_push_subscriptions_query_and_filtering(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params)
        rows = [{"id": "s1", "endpoint": "https://e/1", "p256dh": "k", "auth": "a", "failure_count": 2},
                {"id": "s2", "endpoint": ""}, "junk"]
        return _Resp(200, rows)

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    rows = _client().fetch_push_subscriptions("uid-1")
    assert [r["id"] for r in rows] == ["s1"]
    assert seen == {"url": "https://sb.example/rest/v1/moodle_push_subscriptions",
                    "params": {"user_id": "eq.uid-1", "select": "id,endpoint,p256dh,auth,failure_count"}}


def test_fetch_push_test_requests_query(monkeypatch):
    seen = {}
    monkeypatch.setattr(supabase_client.requests, "get",
                        lambda url, params=None, headers=None, timeout=None: seen.update(url=url, params=params) or _Resp(200, []))
    assert _client().fetch_push_test_requests() == []
    assert seen["url"].endswith("/moodle_push_subscriptions")
    assert seen["params"] == {"test_requested_at": "not.is.null",
                              "select": "id,user_id,endpoint,p256dh,auth,failure_count,test_requested_at"}


def test_push_reads_raise_on_failure_and_are_empty_when_unconfigured(monkeypatch):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(503))
    for read in (lambda c: c.fetch_push_subscriptions("u"), lambda c: c.fetch_push_test_requests()):
        with pytest.raises(RuntimeError, match="HTTP 503"):
            read(_client())
        assert read(SupabaseClient(url="", key="")) == []


def test_update_push_subscription_patches_by_id(monkeypatch):
    seen = {}

    def fake_patch(url, params=None, json=None, headers=None, timeout=None):
        seen.update(url=url, params=params, json=json, prefer=headers["Prefer"])
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "patch", fake_patch)
    assert _client().update_push_subscription("s1", {"test_requested_at": None}) is True
    assert seen == {"url": "https://sb.example/rest/v1/moodle_push_subscriptions", "params": {"id": "eq.s1"},
                    "json": {"test_requested_at": None}, "prefer": "return=minimal"}

    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(supabase_client.requests, "patch", boom)
    assert _client().update_push_subscription("s1", {}) is False


def test_delete_push_subscription_deletes_by_id(monkeypatch):
    seen = {}

    def fake_delete(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params, prefer=headers["Prefer"])
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "delete", fake_delete)
    assert _client().delete_push_subscription("s1") is True
    assert seen == {"url": "https://sb.example/rest/v1/moodle_push_subscriptions", "params": {"id": "eq.s1"},
                    "prefer": "return=minimal"}
    monkeypatch.setattr(supabase_client.requests, "delete", lambda *a, **k: _Resp(500))
    assert _client().delete_push_subscription("s1") is False

    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(supabase_client.requests, "delete", boom)
    assert _client().delete_push_subscription("s1") is False


def test_fetch_admin_users_query(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params)
        return _Resp(200, [{"id": "adm1", "ntfy_topic": "utm-adm1", "ntfy_enabled": True}, {"ntfy_topic": "no-id"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    assert [u["id"] for u in _client().fetch_admin_users()] == ["adm1"]
    assert seen == {"url": "https://sb.example/rest/v1/moodle_users",
                    "params": {"is_admin": "eq.true", "active": "eq.true", "select": "id,ntfy_topic,ntfy_enabled"}}
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(500))
    with pytest.raises(RuntimeError):
        _client().fetch_admin_users()


COLUMN_ERROR = '{"code":"42703","details":null,"hint":null,"message":"column moodle_users.ntfy_enabled does not exist"}'


def test_a_missing_ntfy_enabled_column_is_tolerated_and_remembered(monkeypatch, capsys):
    selects = []

    def fake_get(url, params=None, headers=None, timeout=None):
        selects.append(params["select"])
        if "ntfy_enabled" in params["select"]:
            return _Resp(400, None, text=COLUMN_ERROR)
        return _Resp(200, [{"id": "u1", "token": "t", "ntfy_topic": "x"}, {"id": "u2", "token": " "}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    client = _client()
    assert [u["id"] for u in client.fetch_active_users()] == ["u1"]
    assert selects[0].endswith(",ntfy_enabled") and "ntfy_enabled" not in selects[1] and len(selects) == 2

    client.fetch_active_users()
    assert len(selects) == 3 and "ntfy_enabled" not in selects[2]  # remembered: no second probe
    assert capsys.readouterr().out.count("ntfy_enabled does not exist yet") == 1


def test_the_reminders_join_drops_ntfy_enabled_when_the_column_is_missing(monkeypatch):
    selects = []

    def fake_get(url, params=None, headers=None, timeout=None):
        selects.append(params["select"])
        if "ntfy_enabled" in params["select"]:
            return _Resp(400, None, text=COLUMN_ERROR.replace("moodle_users.", "moodle_users_1."))
        return _Resp(200, [{"id": "r1"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    client = _client()
    assert client.fetch_due_reminders("2026-01-01T00:00:00+00:00") == [{"id": "r1"}]
    assert selects == ["*,moodle_users(ntfy_topic,active,ntfy_enabled)", "*,moodle_users(ntfy_topic,active)"]
    client.fetch_due_reminders("2026-01-01T00:00:00+00:00")
    assert selects[2] == "*,moodle_users(ntfy_topic,active)"


def test_an_unrelated_bad_request_is_not_mistaken_for_the_missing_column(monkeypatch):
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append(params["select"])
        return _Resp(400, None, text='{"message":"invalid input syntax for type uuid"}')

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    with pytest.raises(RuntimeError, match="HTTP 400"):
        _client().fetch_active_users()
    assert len(calls) == 1  # no retry
