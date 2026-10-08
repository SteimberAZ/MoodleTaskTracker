"""Notification history: one buffered row per user-notification, bulk-written, pruned daily, never fatal."""
import re
import time
from datetime import datetime, timedelta, timezone
from functools import partial

import pytest

import api_sync
import class_schedule
import delivery
import notification_log
import notifier
import supabase_client
import worker
from class_reminders import process_class_reminders
from delivery import deliver_to_user, process_push_tests
from moodle_api import MoodleTokenInvalid
from notification_log import NotificationLog
from storage import Storage
from supabase_client import SupabaseClient
from webpush_sender import PushResult

T0 = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone.utc)
UID = "11111111-aaaa-bbbb-cccc-000000000001"
USER = {"id": UID, "moodle_url": "https://m.example", "token": "tok", "ntfy_topic": "utm-aaaaaaaaaaaa",
        "ntfy_enabled": True, "ntfy_confirmed_at": "2026-01-01T00:00:00Z", "last_error": None}
COLUMNS = {"id", "user_id", "kind", "title", "body", "url", "tag", "status", "push_ok", "push_total",
           "ntfy_attempted", "ntfy_ok", "push_state", "created_at"}


@pytest.fixture(autouse=True)
def _fresh_log_state(monkeypatch):
    monkeypatch.delenv("WEB_APP_URL", raising=False)
    delivery.reset_delivery_state()
    yield
    delivery.reset_delivery_state()


# ---- fakes -------------------------------------------------------------------------------------------


class LogDb:
    """Stands in for SupabaseClient on the history side: records bulk inserts and prunes."""

    is_configured = True

    def __init__(self, fail=None):
        self.fail, self.inserts, self.prunes = fail, [], []

    def insert_notification_log(self, rows):
        if self.fail:
            raise self.fail
        self.inserts.append([dict(r) for r in rows])

    def prune_notification_log(self, cutoff_iso):
        if self.fail:
            raise self.fail
        self.prunes.append(cutoff_iso)

    @property
    def rows(self):
        return [r for batch in self.inserts for r in batch]


class SubsDb:
    """Stands in for SupabaseClient on the delivery side (push subscriptions)."""

    is_configured = True

    def __init__(self, n=0):
        self.subs = [{"id": f"s{i}", "endpoint": f"https://push.example/{i}", "p256dh": "k", "auth": "a",
                      "failure_count": 0} for i in range(n)]

    def fetch_push_subscriptions(self, user_id):
        return list(self.subs)


class Sender:
    enabled = True

    def __init__(self, results=None):
        self.results = results or {}

    def send_push(self, sub, payload, ttl, urgency):
        return self.results.get(sub["endpoint"], PushResult.OK)


def _ntfy(ok=True):
    return lambda title, text, priority="default", tags="bell", topic=None: ok


def _log(db=None):
    db = db or LogDb()
    return NotificationLog(db, clock=lambda: T0), db


def _deliverer(log, subs=1, results=None, ntfy_ok=True):
    return partial(deliver_to_user, supabase=SubsDb(subs), sender=Sender(results), ntfy=_ntfy(ntfy_ok), history=log)


class FakeStorage:
    def __init__(self):
        self.recorded = set()

    def has_notified_milestone(self, task_id, milestone, *a):
        return (task_id, milestone) in self.recorded

    def record_milestone(self, task_id, milestone, mirror=True):
        self.recorded.add((task_id, milestone))


# ---- row content per kind ----------------------------------------------------------------------------


def test_a_delivery_records_one_row_with_the_channel_outcome():
    log, db = _log()
    ok = _deliverer(log, subs=3, results={"https://push.example/1": PushResult.FAILED})(
        USER, "Titulo", "Cuerpo", url="/tareas/t1", tag="task-t1", kind="task")
    assert ok is True
    assert log.pending == 1 and db.inserts == []  # buffered: nothing goes out per notification
    assert log.flush() == 1
    assert db.rows == [{
        "id": db.rows[0]["id"], "user_id": UID, "kind": "task", "title": "Titulo", "body": "Cuerpo", "url": "/tareas/t1",
        "tag": "task-t1", "status": "sent", "push_ok": 2, "push_total": 3, "ntfy_attempted": True,
        "ntfy_ok": True, "push_state": "partial", "created_at": "2026-10-06T12:00:00+00:00"}]


@pytest.mark.parametrize("subs, results, ntfy_on, ntfy_ok, expected", [
    (2, {}, True, True, ("sent", 2, 2, True, True)),
    (2, {}, True, False, ("sent", 2, 2, True, False)),  # push rescues a failing ntfy
    (1, {"https://push.example/0": PushResult.FAILED}, True, True, ("sent", 0, 1, True, True)),  # ntfy rescues
    (1, {"https://push.example/0": PushResult.GONE}, False, False, ("failed", 0, 1, False, False)),
    (2, {"https://push.example/0": PushResult.FAILED, "https://push.example/1": PushResult.FAILED}, True, False,
     ("failed", 0, 2, True, False)),
    (0, {}, False, False, ("failed", 0, 0, False, False)),  # no channel at all
    (0, {}, True, True, ("sent", 0, 0, True, True)),  # ntfy only
])
def test_status_and_channel_counts(subs, results, ntfy_on, ntfy_ok, expected):
    log, db = _log()
    user = dict(USER, ntfy_enabled=ntfy_on)
    _deliverer(log, subs=subs, results=results, ntfy_ok=ntfy_ok)(user, "T", "B", kind="reminder")
    log.flush()
    (row,) = db.rows
    assert (row["status"], row["push_ok"], row["push_total"], row["ntfy_attempted"], row["ntfy_ok"]) == expected


@pytest.mark.parametrize("ntfy_on, status", [(True, "sent"), (False, "failed")])
def test_unreadable_subscriptions_are_recorded_as_push_failed_not_as_no_devices(ntfy_on, status):
    class BrokenSubsDb(SubsDb):
        def fetch_push_subscriptions(self, user_id):
            raise RuntimeError("HTTP 503")

    log, db = _log()
    deliver = partial(deliver_to_user, supabase=BrokenSubsDb(), sender=Sender(), ntfy=_ntfy(True), history=log)
    assert deliver(dict(USER, ntfy_enabled=ntfy_on), "T", "B", kind="class") is ntfy_on
    log.flush()
    (row,) = db.rows
    assert (row["status"], row["push_ok"], row["push_total"]) == (status, 0, delivery.PUSH_UNKNOWN)


def test_a_user_without_a_topic_has_no_ntfy_attempt_in_the_row():
    log, db = _log()
    _deliverer(log, subs=1)(dict(USER, ntfy_topic=""), "T", "B", kind="task")
    log.flush()
    assert (db.rows[0]["ntfy_attempted"], db.rows[0]["ntfy_ok"]) == (False, False)


def test_task_milestones_are_recorded_as_task():
    log, db = _log()
    storage, t = FakeStorage(), {"id": "t1", "title": "Tarea", "course": "Curso", "due_date_str": "hoy",
                                 "due_timestamp": int(time.time()) + 5 * 3600, "status": "pending",
                                 "task_url": "https://m.example/mod/assign/view.php?id=1"}
    notifier.TaskNotificationManager.process_milestones(
        [t], storage, new_tasks=[t], desktop=False, deliver=partial(_deliverer(log), USER))
    log.flush()
    assert [r["kind"] for r in db.rows] == ["task", "task"]  # "new" and "8h"
    assert {r["url"] for r in db.rows} == {"/tareas/t1"} and {r["tag"] for r in db.rows} == {"task-t1"}
    assert ("t1", "8h") in storage.recorded


def test_custom_reminders_are_recorded_as_reminder():
    log, db = _log()
    send = worker.reminder_deliverer(_deliverer(log))
    assert send(USER, {"id": "r9"}, "Beber agua", "Ahora") is True
    log.flush()
    assert [(r["kind"], r["title"], r["tag"], r["url"]) for r in db.rows] == [("reminder", "Beber agua", "reminder-r9", "/")]


class ClassDb:
    is_configured = True

    def __init__(self, admins=()):
        self.admins = list(admins)

    def fetch_class_reminder_users(self):
        return [{"id": UID, "ntfy_topic": "utm-x", "ntfy_enabled": True, "class_reminder_minutes": 30}]

    def fetch_class_schedule(self, user_ids, weekday):
        return [{"id": "c1", "user_id": UID, "subject": "FISICA", "weekday": weekday, "start_time": "07:00:00",
                 "end_time": "09:00:00"}]

    def fetch_admin_users(self):
        return list(self.admins)

    def fetch_users_with_schedule(self, ids):
        return set()


def test_imported_class_reminders_are_recorded_as_class():
    log, db = _log()
    now = datetime(2026, 10, 6, 6, 40, tzinfo=class_schedule.ECUADOR_TZ)  # a Tuesday
    assert process_class_reminders(FakeStorage(), ClassDb(), _deliverer(log), now=now) == 1
    log.flush()
    (row,) = db.rows
    assert (row["kind"], row["url"]) == ("class", "/horario") and row["tag"].startswith("class-2-0700-")


def test_the_built_in_schedule_delivered_to_an_admin_is_recorded_as_class():
    log, db = _log()
    admin = {"id": "adm1", "ntfy_topic": "utm-adm1", "ntfy_enabled": True}
    assert class_schedule.notify_class(class_schedule.CLASS_SCHEDULE[1], 20, ClassDb([admin]), _deliverer(log))
    log.flush()
    (row,) = db.rows
    assert (row["user_id"], row["kind"]) == ("adm1", "class")


def test_moodle_disconnected_and_reconnected_are_recorded_as_status(tmp_path):
    class NoSupabase:
        is_configured = False

    class UserDb:
        is_configured = True

        def update_user(self, user_id, fields):
            return True

    class Client:
        def __init__(self, exc=None):
            self.exc = exc

        def fetch_tasks(self):
            if self.exc:
                raise self.exc
            return []

    log, db = _log()
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = NoSupabase()
    deliver = _deliverer(log)
    bad = MoodleTokenInvalid("bad token", code="invalidtoken")
    api_sync.sync_user_via_api(s, USER, UserDb(), client=Client(bad), deliver=deliver)
    api_sync.sync_user_via_api(s, USER, UserDb(), client=Client(), process=lambda *a, **k: None, deliver=deliver)
    log.flush()
    assert [(r["kind"], r["title"], r["tag"]) for r in db.rows] == [
        ("status", "Moodle desconectado", "moodle-status"), ("status", "Moodle reconectado", "moodle-status")]


class PushTestDb:
    def __init__(self, n):
        self.rows = [{"id": f"s{i}", "user_id": UID, "endpoint": f"https://push.example/{i}", "p256dh": "k",
                      "auth": "a", "failure_count": 0} for i in range(n)]

    is_configured = True

    def fetch_push_test_requests(self):
        return list(self.rows)

    def update_push_subscription(self, sub_id, fields):
        return True

    def clear_push_test_request(self, sub_id, requested_at):
        return True


def test_push_tests_are_recorded_as_test_one_row_per_device():
    log, db = _log()
    sender = Sender({"https://push.example/1": PushResult.GONE})
    assert process_push_tests(PushTestDb(2), sender, history=log) == 1
    log.flush()
    assert [(r["kind"], r["status"], r["push_ok"], r["push_total"], r["ntfy_attempted"]) for r in db.rows] == [
        ("test", "sent", 1, 1, False), ("test", "failed", 0, 1, False)]
    assert db.rows[0]["title"] == delivery.TEST_PAYLOAD["title"]
    assert (db.rows[0]["url"], db.rows[0]["tag"]) == ("/notificaciones", "test")


def test_a_send_without_a_user_id_or_a_kind_is_not_recorded():
    log, db = _log()
    deliver = _deliverer(log)
    legacy = {"ntfy_topic": "utm-x", "ntfy_enabled": True, "ntfy_confirmed_at": "2026-01-01T00:00:00Z"}
    assert deliver(legacy, "T", "B", kind="task") is True  # legacy env-topic style: no user id
    assert deliver(USER, "T", "B") is True  # no kind chosen by the caller
    assert deliver_to_user(USER, "T", "B", kind="task", sender=None, supabase=None, ntfy=_ntfy()) is True  # no history
    assert log.pending == 0
    unknown = _log()[0]
    unknown.record(UID, "bogus", "T")
    assert unknown.pending == 0


def test_nothing_is_buffered_without_a_configured_database():
    db = LogDb()
    db.is_configured = False
    log = NotificationLog(db, clock=lambda: T0)
    _deliverer(log)(USER, "T", "B", kind="task")
    assert log.pending == 0 and log.flush() == 0 and db.inserts == []


# ---- tapping a notification opens its own history entry ----------------------------------------------


class RecordingSender(Sender):
    def __init__(self):
        super().__init__()
        self.payloads = []

    def send_push(self, sub, payload, ttl, urgency):
        self.payloads.append(dict(payload))
        return super().send_push(sub, payload, ttl, urgency)


UUID4 = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"


def test_the_row_id_is_generated_once_and_used_by_the_push_link_and_the_row():
    log, db = _log()
    sender = RecordingSender()
    deliver = partial(deliver_to_user, supabase=SubsDb(2), sender=sender, ntfy=_ntfy(), history=log)
    assert deliver(USER, "Titulo", "Cuerpo", url="/tareas/t1", tag="task-t1", kind="task") is True
    log.flush()
    (row,) = db.rows
    assert re.fullmatch(UUID4, row["id"])
    assert len(sender.payloads) == 2  # one push per device, every one with the same link
    for payload in sender.payloads:
        assert payload["url"] == f"/notificaciones?n={row['id']}"
        assert payload["target"] == "/tareas/t1"
    assert row["url"] == "/tareas/t1"  # the row keeps the page the notification is about


def test_every_notification_gets_its_own_id():
    log, db = _log()
    sender = RecordingSender()
    deliver = partial(deliver_to_user, supabase=SubsDb(1), sender=sender, ntfy=_ntfy(), history=log)
    deliver(USER, "A", "x", kind="task")
    deliver(USER, "B", "y", kind="task")
    log.flush()
    ids = [r["id"] for r in db.rows]
    assert len(set(ids)) == 2
    assert [p["url"] for p in sender.payloads] == [f"/notificaciones?n={i}" for i in ids]


@pytest.mark.parametrize("make_history", [
    lambda: None,  # no history wired
    lambda: NotificationLog(type("Off", (), {"is_configured": False})()),  # database not configured
])
def test_without_a_usable_history_the_push_links_to_plain_avisos(make_history):
    sender = RecordingSender()
    deliver_to_user(USER, "T", "B", url="/tareas/t1", kind="task", history=make_history(), supabase=SubsDb(1),
                    sender=sender, ntfy=_ntfy())
    assert [(p["url"], p["target"]) for p in sender.payloads] == [("/notificaciones", "/tareas/t1")]


def test_without_a_kind_or_user_id_there_is_no_row_to_point_at():
    log, _ = _log()
    sender = RecordingSender()
    deliver_to_user(USER, "T", "B", history=log, supabase=SubsDb(1), sender=sender, ntfy=_ntfy())  # no kind
    assert sender.payloads[0]["url"] == "/notificaciones" and log.pending == 0


def test_a_history_that_breaks_never_fails_the_delivery_and_the_link_still_works():
    class Boom:
        def record(self, *a, **k):
            raise RuntimeError("history down")

    sender = RecordingSender()
    assert deliver_to_user(USER, "T", "B", kind="task", history=Boom(), supabase=SubsDb(1), sender=sender,
                           ntfy=_ntfy()) is True
    assert re.fullmatch(r"/notificaciones\?n=" + UUID4, sender.payloads[0]["url"])


def test_push_tests_link_to_their_own_row_too():
    log, db = _log()
    sender = RecordingSender()
    assert process_push_tests(PushTestDb(2), sender, history=log) == 2
    log.flush()
    assert [p["url"] for p in sender.payloads] == [f"/notificaciones?n={r['id']}" for r in db.rows]
    assert {p["target"] for p in sender.payloads} == {"/notificaciones"}
    assert len({r["id"] for r in db.rows}) == 2
    plain = RecordingSender()
    process_push_tests(PushTestDb(1), plain)  # no history: plain Avisos
    assert plain.payloads[0]["url"] == "/notificaciones"


class ClickNtfy:
    """ntfy sender that accepts the optional ``click`` keyword and records it."""

    def __init__(self):
        self.calls = []

    def __call__(self, title, text, priority="default", tags="bell", topic=None, click=None):
        self.calls.append(click)
        return True


def test_ntfy_gets_the_same_absolute_link_as_click_when_the_web_app_url_is_set(monkeypatch):
    monkeypatch.setenv("WEB_APP_URL", " https://moodletasktracker.vercel.app/ ")
    log, db = _log()
    ntfy = ClickNtfy()
    deliver_to_user(USER, "T", "B", url="/tareas/t1", kind="task", history=log, supabase=SubsDb(0), sender=Sender(),
                    ntfy=ntfy)
    log.flush()
    assert ntfy.calls == [f"https://moodletasktracker.vercel.app/notificaciones?n={db.rows[0]['id']}"]

    plain = ClickNtfy()  # no history: still a click, on plain Avisos
    deliver_to_user(USER, "T", "B", kind="task", supabase=SubsDb(0), sender=Sender(), ntfy=plain)
    assert plain.calls == ["https://moodletasktracker.vercel.app/notificaciones"]


def test_ntfy_is_called_exactly_as_before_without_a_web_app_url():
    log, _ = _log()
    seen = []

    def strict(title, text, priority="default", tags="bell", topic=None):  # no click parameter at all
        seen.append(topic)
        return True

    assert deliver_to_user(USER, "T", "B", kind="task", history=log, supabase=SubsDb(0), sender=Sender(),
                           ntfy=strict) is True
    assert seen == [USER["ntfy_topic"]]


def test_post_ntfy_sends_the_click_header_only_when_given(monkeypatch):
    sent = []

    class Resp:
        status_code = 200
        text = ""

    import requests

    monkeypatch.setattr(requests, "post", lambda url, data=None, headers=None, timeout=None: sent.append(headers) or Resp())
    assert notifier.post_ntfy("T", "B", topic="utm-x") is True
    assert notifier.post_ntfy("T", "B", topic="utm-x", click="https://app.example/notificaciones?n=1") is True
    assert "Click" not in sent[0]
    assert sent[1]["Click"] == "https://app.example/notificaciones?n=1"


def test_the_push_payload_carries_target_and_stays_small():
    import json
    import webpush_sender as ws

    data = json.loads(ws.encode_payload({"title": "t", "body": "b", "url": "/notificaciones?n=x", "target": "/tareas/t1",
                                         "tag": "g"}))
    assert isinstance(data.pop("timestamp"), int)
    assert data == {"title": "t", "body": "b", "url": "/notificaciones?n=x", "tag": "g", "target": "/tareas/t1"}
    assert "target" not in json.loads(ws.encode_payload({"title": "t", "body": "b", "url": "/"}))


# ---- row shape ---------------------------------------------------------------------------------------


def test_title_and_body_are_truncated():
    log, db = _log()
    _deliverer(log)(USER, "t" * 500, "b" * 5000, kind="task")
    log.flush()
    row = db.rows[0]
    assert len(row["title"]) == notification_log.TITLE_MAX == 200 and row["title"].endswith("…")
    assert len(row["body"]) == notification_log.BODY_MAX == 1000 and row["body"].endswith("…")
    exact = notification_log.build_row(UID, "task", "x" * 200, "y" * 1000, "/", "t", push_ok=0, push_total=0,
                                       ntfy_attempted=False, ntfy_ok=False, created_at=T0)
    assert (exact["title"], exact["body"]) == ("x" * 200, "y" * 1000)  # at the limit: untouched


def test_every_row_has_the_same_keys_even_with_empty_optional_columns():
    log, db = _log()
    deliver = _deliverer(log)
    deliver(USER, "T", "B", url="/tareas/t1", tag="task-t1", kind="task")
    deliver(USER, "Solo titulo", "", url="", tag="", kind="status")
    log.record(UID, "class", "Sin nada")
    log.flush()
    assert len(db.rows) == 3 and all(set(r) == COLUMNS for r in db.rows)
    assert (db.rows[1]["body"], db.rows[1]["url"], db.rows[1]["tag"]) == (None, None, None)
    assert len(db.inserts) == 1  # one bulk request for the whole tick


def test_created_at_is_explicit_utc_so_rows_of_one_tick_stay_ordered():
    ticks = iter(T0 + timedelta(seconds=i) for i in range(2))
    log = NotificationLog(LogDb(), clock=lambda: next(ticks))
    log.record(UID, "task", "A")
    log.record(UID, "task", "B")
    log.flush()
    assert [r["created_at"] for r in log.supabase.rows] == ["2026-10-06T12:00:00+00:00", "2026-10-06T12:00:01+00:00"]


def test_large_ticks_are_split_into_chunks():
    log, db = _log()
    for i in range(450):
        log.record(UID, "task", f"n{i}")
    assert log.flush() == 450
    assert [len(b) for b in db.inserts] == [200, 200, 50]


# ---- logging never affects delivery ------------------------------------------------------------------


def test_a_history_that_raises_does_not_change_the_delivery_result(capsys):
    class Boom:
        def record(self, *a, **k):
            raise RuntimeError("history down")

    for _ in range(2):
        assert deliver_to_user(USER, "T", "B", kind="task", history=Boom(), sender=None, supabase=None,
                               ntfy=_ntfy()) is True
        assert deliver_to_user(USER, "T", "B", tag="t-fail", kind="task", history=Boom(), sender=None,
                               supabase=None, ntfy=_ntfy(False)) is False
        delivery.forget(UID, "task", "t-fail")  # the failure above waits for its backoff; retry it now
    assert capsys.readouterr().out.count("could not record the notification history") == 1


def test_a_failing_insert_never_breaks_the_flush_nor_the_milestones(capsys):
    log, db = _log(LogDb(fail=RuntimeError("HTTP 503: down")))
    storage, t = FakeStorage(), {"id": "t1", "title": "Tarea", "course": "Curso", "due_date_str": "hoy",
                                 "due_timestamp": int(time.time()) + 5 * 3600, "status": "pending"}
    notifier.TaskNotificationManager.process_milestones(
        [t], storage, new_tasks=[t], desktop=False, deliver=partial(_deliverer(log), USER))
    assert log.pending == 2
    assert log.flush() == 0  # no exception, rows kept for a retry
    assert storage.recorded == {("t1", m) for m in ("new", "8h", "1d", "2d", "3d")}  # dedupe untouched
    assert log.pending == 2
    for _ in range(notification_log.MAX_FLUSH_ATTEMPTS - 1):
        assert log.flush() == 0
    assert log.pending == 0 and log.flush() == 0 and db.inserts == []  # bounded: dropped after the last try
    assert capsys.readouterr().out.count("could not record notifications (kept for a retry)") == 1


def test_an_unreachable_database_is_logged_once_until_it_recovers(capsys):
    db = LogDb(fail=ConnectionError("timed out"))
    log = NotificationLog(db, clock=lambda: T0)
    for _ in range(3):
        log.record(UID, "task", "T")
        log.flush()
    assert capsys.readouterr().out.count("[History] could not record") == 1
    db.fail = None
    log.record(UID, "task", "T")
    assert log.flush() == 3  # the two rows still within their attempts, plus the new one
    db.fail = ConnectionError("timed out")
    log.record(UID, "task", "T")
    log.flush()
    assert capsys.readouterr().out.count("[History] could not record") == 1  # healthy in between: reported again


def test_rows_of_a_failed_insert_are_written_by_the_next_flush():
    db = LogDb(fail=ConnectionError("timed out"))
    log = NotificationLog(db, clock=lambda: T0)
    log.record(UID, "class", "Clase", log_id="11111111-1111-4111-8111-111111111111")
    assert log.flush() == 0 and log.pending == 1
    db.fail = None
    assert log.flush() == 1
    assert [r["id"] for r in db.rows] == ["11111111-1111-4111-8111-111111111111"]  # the id the push links to
    assert log.pending == 0


def test_the_retry_buffer_is_bounded(monkeypatch):
    monkeypatch.setattr(notification_log, "MAX_BUFFERED_ROWS", 5)
    db = LogDb(fail=ConnectionError("timed out"))
    log = NotificationLog(db, clock=lambda: T0)
    for i in range(8):
        log.record(UID, "task", f"n{i}")
    log.flush()
    assert log.pending == 5
    db.fail = None
    log.flush()
    assert [r["title"] for r in db.rows] == ["n3", "n4", "n5", "n6", "n7"]  # the oldest were dropped


def test_a_missing_table_is_logged_once_and_never_raises(capsys):
    body = '{"code":"PGRST205","message":"Could not find the table \'public.moodle_notification_log\'"}'
    log, db = _log(LogDb(fail=RuntimeError(f"HTTP 404: {body}")))
    for _ in range(3):
        log.record(UID, "task", "T")
        assert log.flush() == 0
    out = capsys.readouterr().out
    assert out.count("moodle_notification_log does not exist yet") == 1 and "re-run supabase_schema.sql" in out
    assert db.inserts == [] and log.pending == 0


# ---- pruning -----------------------------------------------------------------------------------------


class Settings:
    def __init__(self, **values):
        self.values, self.writes = dict(values), []

    def get_setting(self, key, default=None):
        return self.values.get(key, default)

    def set_setting(self, key, value):
        self.values[key] = str(value)
        self.writes.append(key)


def test_pruning_deletes_rows_older_than_90_days_at_most_once_a_day():
    log, db = _log()
    settings = Settings()
    assert log.prune_if_due(settings, now=T0) is True  # never ran: due now
    assert db.prunes == ["2026-07-08T12:00:00Z"] and notification_log.RETENTION_DAYS == 90
    assert settings.values[notification_log.PRUNE_SETTING] == str(int(T0.timestamp()))

    assert log.prune_if_due(settings, now=T0 + timedelta(hours=23, minutes=59)) is False
    assert len(db.prunes) == 1
    assert log.prune_if_due(settings, now=T0 + timedelta(hours=24)) is True
    assert db.prunes[1] == "2026-07-09T12:00:00Z"


def test_a_failing_prune_is_not_fatal_not_retried_every_tick_and_logged_once(capsys):
    log, db = _log(LogDb(fail=RuntimeError("HTTP 503: down")))
    settings = Settings()
    assert log.prune_if_due(settings, now=T0) is False
    assert log.prune_if_due(settings, now=T0 + timedelta(minutes=1)) is False  # waits for tomorrow
    assert settings.writes == [notification_log.PRUNE_SETTING]
    assert capsys.readouterr().out.count("could not prune") == 1


def test_pruning_a_missing_table_is_quiet_and_not_fatal(capsys):
    log, _ = _log(LogDb(fail=RuntimeError("HTTP 404: PGRST205")))
    assert log.prune_if_due(Settings(), now=T0) is False
    assert "nothing to prune" in capsys.readouterr().out


def test_prune_ignores_a_garbled_last_run_and_an_unconfigured_database():
    log, db = _log()
    assert log.prune_if_due(Settings(**{notification_log.PRUNE_SETTING: "not-a-number"}), now=T0) is True
    off = LogDb()
    off.is_configured = False
    assert NotificationLog(off).prune_if_due(Settings(), now=T0) is False and off.prunes == []


def test_the_prune_time_is_a_local_setting_that_is_never_mirrored(tmp_path):
    class Mirror:
        is_configured = True

        def __init__(self):
            self.upserts = []

        def upsert_setting(self, key, value, async_call=True):
            self.upserts.append(key)

    s = Storage(str(tmp_path / "t.db"))
    s.supabase = Mirror()
    s.set_setting(notification_log.PRUNE_SETTING, "123")
    s.set_setting("check_interval_mins", "15")
    assert s.get_setting(notification_log.PRUNE_SETTING) == "123"
    assert s.supabase.upserts == ["check_interval_mins"]


# ---- Supabase REST shapes ----------------------------------------------------------------------------


class _Resp:
    def __init__(self, status=201, text=""):
        self.status_code, self.text = status, text


def _client():
    return SupabaseClient(url="https://sb.example", key="k")


def test_insert_notification_log_posts_one_bulk_request(monkeypatch):
    seen = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen.update(url=url, json=json, prefer=headers["Prefer"], timeout=timeout)
        return _Resp(201)

    monkeypatch.setattr(supabase_client.requests, "post", fake_post)
    rows = [{"user_id": UID, "kind": "task"}, {"user_id": UID, "kind": "class"}]
    _client().insert_notification_log(rows)
    assert seen == {"url": "https://sb.example/rest/v1/moodle_notification_log?on_conflict=id", "json": rows,
                    "prefer": "resolution=ignore-duplicates,return=minimal", "timeout": 15}


def test_insert_notification_log_raises_on_http_errors_and_ignores_empty_or_unconfigured(monkeypatch):
    calls = []
    monkeypatch.setattr(supabase_client.requests, "post",
                        lambda *a, **k: calls.append(1) or _Resp(404, '{"code":"PGRST205"}'))
    with pytest.raises(RuntimeError, match="HTTP 404.*PGRST205"):
        _client().insert_notification_log([{"user_id": UID}])
    _client().insert_notification_log([])
    SupabaseClient(url="", key="").insert_notification_log([{"user_id": UID}])
    assert len(calls) == 1


def test_prune_notification_log_deletes_by_cutoff(monkeypatch):
    seen = {}

    def fake_delete(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params, prefer=headers["Prefer"])
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "delete", fake_delete)
    _client().prune_notification_log("2026-07-08T12:00:00Z")
    assert seen == {"url": "https://sb.example/rest/v1/moodle_notification_log",
                    "params": {"created_at": "lt.2026-07-08T12:00:00Z"}, "prefer": "return=minimal"}
    monkeypatch.setattr(supabase_client.requests, "delete", lambda *a, **k: _Resp(500, "boom"))
    with pytest.raises(RuntimeError, match="HTTP 500"):
        _client().prune_notification_log("2026-07-08T12:00:00Z")
    SupabaseClient(url="", key="").prune_notification_log("x")  # no-op, no request


# ---- worker wiring -----------------------------------------------------------------------------------


def test_the_worker_writes_the_buffered_history_and_prunes_even_when_a_tick_crashes(monkeypatch, tmp_path):
    db = LogDb()

    class OffSender:
        enabled, status, warning = False, "off", ""

    class Offline:
        is_configured, url = False, ""

    storage = Storage(str(tmp_path / "t.db"))
    storage.supabase = Offline()
    monkeypatch.setattr(worker, "Storage", lambda: storage)
    monkeypatch.setattr(worker.SupabaseClient, "for_worker", classmethod(lambda cls: db))
    monkeypatch.setattr(worker.WebPushSender, "from_env", classmethod(lambda cls, sb: OffSender()))
    monkeypatch.setattr(worker, "process_class_reminders",
                        lambda st, sb, deliver: deliver({"id": UID, "ntfy_topic": ""}, "Clase", "Hoy", kind="class"))
    for name in ("check_and_notify_upcoming_classes", "process_due_reminders", "process_push_tests"):
        monkeypatch.setattr(worker, name, lambda *a, **k: 0)

    def crash(*a, **k):
        raise RuntimeError("tick crashed")

    monkeypatch.setattr(worker, "run_task_tick", crash)
    with pytest.raises(RuntimeError, match="tick crashed"):
        worker.run_worker()
    assert [(r["kind"], r["status"], r["title"]) for r in db.rows] == [("class", "failed", "Clase")]
    assert len(db.prunes) == 1


def test_reminder_history_is_written_before_the_task_sync_and_after_each_user(monkeypatch, tmp_path):
    db = LogDb()

    class OffSender:
        enabled, status, warning = False, "off", ""

    class Offline:
        is_configured, url = False, ""

    storage = Storage(str(tmp_path / "t.db"))
    storage.supabase = Offline()
    monkeypatch.setattr(worker, "Storage", lambda: storage)
    monkeypatch.setattr(worker.SupabaseClient, "for_worker", classmethod(lambda cls: db))
    monkeypatch.setattr(worker.WebPushSender, "from_env", classmethod(lambda cls, sb: OffSender()))
    monkeypatch.setattr(worker, "process_class_reminders",
                        lambda st, sb, deliver: deliver({"id": UID, "ntfy_topic": ""}, "Clase", "Hoy", kind="class"))
    for name in ("check_and_notify_upcoming_classes", "process_due_reminders", "process_push_tests"):
        monkeypatch.setattr(worker, name, lambda *a, **k: 0)
    seen = {}

    def tick(*a, after_user=None, **k):
        seen["rows_before_sync"] = [r["title"] for r in db.rows]
        seen["after_user"] = after_user
        raise RuntimeError("stop")

    monkeypatch.setattr(worker, "run_task_tick", tick)
    with pytest.raises(RuntimeError, match="stop"):
        worker.run_worker()
    assert seen["rows_before_sync"] == ["Clase"]  # a tapped class push finds its row during the sync
    assert seen["after_user"] is not None


def test_sync_all_users_runs_the_hook_after_each_synced_user(monkeypatch):
    calls = []
    monkeypatch.setattr(worker, "sync_user_via_api", lambda *a, **k: calls.append("sync") or "ok")
    users = [{"id": f"u{i}", "ntfy_topic": "utm-x", "token": "t"} for i in range(2)]
    worker.sync_all_users(None, None, users, after_user=lambda: calls.append("flush"))
    assert calls == ["sync", "flush", "sync", "flush"]
