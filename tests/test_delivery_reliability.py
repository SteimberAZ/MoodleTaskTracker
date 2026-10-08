"""pkg-delivery-core: honest success rule, push_state, bounded retries/backoff and history volume."""
from datetime import datetime, timezone

import pytest

import delivery
import notification_log
import notifier
from delivery import MAX_ATTEMPTS, deliver_to_user, is_exhausted, process_push_tests
from notification_log import NotificationLog
from webpush_sender import PushResult

UID = "11111111-aaaa-bbbb-cccc-000000000001"
CONFIRMED = "2026-01-01T00:00:00Z"
# 2026-10-06 12:00 UTC = 07:00 in Ecuador: the whole test day stays on one calendar day there.
T0 = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone.utc).timestamp()


def _user(ntfy=True, confirmed=False, **over):
    user = {"id": UID, "ntfy_topic": "utm-aaaaaaaaaaaa", "ntfy_enabled": ntfy}
    if confirmed:
        user["ntfy_confirmed_at"] = CONFIRMED
    user.update(over)
    return user


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t

    def minutes(self, n):
        self.t += n * 60


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.delenv("WEB_APP_URL", raising=False)
    delivery.reset_delivery_state()
    c = Clock()
    monkeypatch.setattr(delivery, "_now", c)
    yield c
    delivery.reset_delivery_state()


class LogDb:
    is_configured = True

    def __init__(self):
        self.inserts, self.fail = [], None

    def insert_notification_log(self, rows):
        if self.fail:
            raise self.fail
        self.inserts.append([dict(r) for r in rows])

    @property
    def rows(self):
        return [r for batch in self.inserts for r in batch]


class SubsDb:
    is_configured = True

    def __init__(self, n=1, fail=False):
        self.n, self.fail, self.reads = n, fail, 0

    def fetch_push_subscriptions(self, user_id):
        self.reads += 1
        if self.fail:
            raise RuntimeError("HTTP 503")
        return [{"id": f"s{i}", "endpoint": f"https://push.example/{i}", "p256dh": "k", "auth": "a"}
                for i in range(self.n)]


class Sender:
    def __init__(self, results=None, enabled=True):
        self.results, self.enabled, self.sent = results or {}, enabled, []

    def send_push(self, sub, payload, ttl, urgency):
        self.sent.append(payload)
        return self.results.get(sub["endpoint"], PushResult.OK)


class Ntfy:
    def __init__(self, ok=True):
        self.ok, self.calls = ok, 0

    def __call__(self, title, text, priority="default", tags="bell", topic=None):
        self.calls += 1
        return self.ok


ALL_FAIL = {f"https://push.example/{i}": PushResult.FAILED for i in range(4)}


def _send(user=None, db=None, sender=None, ntfy=None, history=None, **kw):
    return deliver_to_user(user or _user(), "Titulo", "Cuerpo", url="/tareas/t1", tag="task-t1", kind="task",
                           supabase=db, sender=sender, ntfy=ntfy, history=history, **kw)


def _history():
    db = LogDb()
    return NotificationLog(db), db


def _states(db):
    return [(r["status"], r["push_state"]) for r in db.rows]


# ---- success rule and push_state ---------------------------------------------------------------------


def test_failed_push_with_unconfirmed_ntfy_is_not_delivered_and_ntfy_is_not_resent(clock):
    log, db = _history()
    sender, ntfy = Sender(ALL_FAIL), Ntfy(ok=True)
    assert _send(db=SubsDb(1), sender=sender, ntfy=ntfy, history=log) is False
    assert ntfy.calls == 1 and len(sender.sent) == 1
    clock.minutes(1)  # first backoff step
    assert _send(db=SubsDb(1), sender=sender, ntfy=ntfy, history=log) is False
    assert len(sender.sent) == 2 and ntfy.calls == 1  # push retried, the ntfy copy is not sent twice
    log.flush()
    assert _states(db) == [("failed", "failed")]  # one row for the streak so far, not one per attempt
    assert db.rows[0]["ntfy_ok"] is True


def test_confirmed_ntfy_alone_is_delivered():
    log, db = _history()
    assert _send(user=_user(confirmed=True), ntfy=Ntfy(), history=log) is True
    log.flush()
    assert _states(db) == [("sent", "disabled")]


def test_a_disabled_sender_is_never_success_and_records_disabled():
    log, db = _history()
    db_subs = SubsDb(2)
    assert _send(db=db_subs, sender=Sender(enabled=False), ntfy=Ntfy(), history=log) is False
    assert db_subs.reads == 0
    log.flush()
    assert _states(db) == [("failed", "disabled")]


def test_unreadable_subscriptions_record_read_error():
    log, db = _history()
    assert _send(db=SubsDb(fail=True), sender=Sender(), ntfy=Ntfy(), history=log) is False
    log.flush()
    assert _states(db) == [("failed", "read_error")] and db.rows[0]["push_total"] == delivery.PUSH_UNKNOWN


def test_partial_push_is_delivered_and_recorded_as_partial():
    log, db = _history()
    sender = Sender({"https://push.example/1": PushResult.FAILED})
    assert _send(user=_user(ntfy=False), db=SubsDb(3), sender=sender, history=log) is True
    log.flush()
    assert _states(db) == [("sent", "partial")] and (db.rows[0]["push_ok"], db.rows[0]["push_total"]) == (2, 3)


def test_all_devices_ok_is_recorded_as_ok():
    log, db = _history()
    assert _send(user=_user(ntfy=False), db=SubsDb(2), sender=Sender(), history=log) is True
    log.flush()
    assert _states(db) == [("sent", "ok")]


def test_a_missing_ntfy_enabled_means_off():
    ntfy = Ntfy()
    user = {"id": UID, "ntfy_topic": "utm-x", "ntfy_confirmed_at": CONFIRMED}
    assert _send(user=user, db=SubsDb(1), sender=Sender(), ntfy=ntfy) is True
    assert ntfy.calls == 0


# ---- bounded retries ---------------------------------------------------------------------------------


def test_backoff_skips_send_nothing_and_record_nothing(clock):
    log, db = _history()
    sender, ntfy = Sender(ALL_FAIL), Ntfy(ok=False)
    _send(db=SubsDb(1), sender=sender, ntfy=ntfy, history=log)
    for _ in range(5):
        clock.t += 10  # still inside the first 1-minute wait
        assert _send(db=SubsDb(1), sender=sender, ntfy=ntfy, history=log) is False
    assert len(sender.sent) == 1 and ntfy.calls == 1 and log.pending == 1


def test_backoff_follows_1_5_15_60_60_minutes(clock):
    sender = Sender(ALL_FAIL)
    waits = [1, 5, 15, 60, 60]
    _send(db=SubsDb(1), sender=sender)
    for wait in waits:
        clock.minutes(wait - 0.1)
        _send(db=SubsDb(1), sender=sender)
        before = len(sender.sent)
        clock.minutes(0.1)
        _send(db=SubsDb(1), sender=sender)
        assert len(sender.sent) == before + 1
    assert len(sender.sent) == 6


def test_exhaustion_after_six_attempts_writes_at_most_three_rows_per_streak(clock):
    log, db = _history()
    sender = Sender(ALL_FAIL)
    attempts = 0
    for _ in range(400):  # one tick per minute for well over the whole backoff ladder
        before = len(sender.sent)
        _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender, history=log)
        attempts += len(sender.sent) - before
        if attempts == MAX_ATTEMPTS:
            break
        clock.minutes(1)
    assert attempts == MAX_ATTEMPTS and is_exhausted(UID, "task", "task-t1")
    sender.results = {}  # the device works again
    clock.minutes(61)
    assert _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender, history=log) is True
    assert not is_exhausted(UID, "task", "task-t1")
    log.flush()
    assert _states(db) == [("failed", "failed"), ("failed", "failed"), ("sent", "ok")]


class OutageSender(Sender):
    """Every push is refused for reasons on our side (429/5xx, our VAPID/JWT): not the device's fault."""

    last_failure_server_side = True

    def send_push(self, sub, payload, ttl, urgency):
        self.sent.append(payload)
        return PushResult.FAILED


@pytest.mark.parametrize("make", [
    lambda: dict(db=SubsDb(1), sender=OutageSender()),  # push service outage or our JWT rejected
    lambda: dict(db=SubsDb(1, fail=True), sender=Sender()),  # subscriptions unreadable
    lambda: dict(db=SubsDb(1), sender=Sender(enabled=False)),  # sender disabled
], ids=["server-side", "read-error", "disabled"])
def test_our_own_outages_never_exhaust_a_notification(clock, make):
    log, db = _history()
    kwargs = make()
    for _ in range(600):  # ten hours of one tick per minute
        _send(user=_user(ntfy=False), history=log, **kwargs)
        clock.minutes(1)
    state = delivery._ATTEMPTS[(UID, "task", "task-t1")]
    assert state["attempts"] > MAX_ATTEMPTS and not is_exhausted(UID, "task", "task-t1")
    log.flush()
    assert len(db.rows) == 1  # one "failed" row for the streak, never one per attempt


def test_a_device_failure_still_counts_towards_giving_up(clock):
    sender = Sender(ALL_FAIL)
    sender.last_failure_server_side = False
    for _ in range(400):
        _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender)
        clock.minutes(1)
    assert is_exhausted(UID, "task", "task-t1")


def test_success_clears_the_streak(clock):
    sender = Sender(ALL_FAIL)
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender)
    clock.minutes(1)
    sender.results = {}
    assert _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender) is True
    assert delivery._ATTEMPTS == {}


def test_retry_key_separates_notifications_that_share_a_tag(clock):
    sender = Sender(ALL_FAIL)
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender, retry_key="task-t1:3d")
    sender.results = {}
    assert _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender, retry_key="task-t1:2d") is True
    assert is_exhausted(UID, "task", "task-t1:3d") is False and (UID, "task", "task-t1:3d") in delivery._ATTEMPTS


def test_no_usable_channel_records_one_row_per_key_and_day(clock):
    log, db = _history()
    for _ in range(100):
        assert _send(user=_user(ntfy=False), db=SubsDb(0), sender=Sender(), history=log) is False
        clock.minutes(1)
    log.flush()
    assert _states(db) == [("failed", "no_devices")]
    clock.t = T0 + 24 * 3600  # next day, the key still failing
    _send(user=_user(ntfy=False), db=SubsDb(0), sender=Sender(), history=log)
    log.flush()
    assert len(db.rows) == 2


def test_no_usable_channel_with_the_sender_off_records_disabled(clock):
    log, db = _history()
    for _ in range(10):
        _send(user=_user(ntfy=False), sender=None, history=log)
        clock.minutes(30)
    log.flush()
    assert _states(db) == [("failed", "disabled")]


def test_stale_state_is_pruned_after_24_hours(clock):
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=Sender(ALL_FAIL))
    assert delivery._ATTEMPTS
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=Sender(ALL_FAIL))  # inside the backoff wait
    stale = f"backoff {(UID, 'task', 'task-t1')}"
    assert stale in delivery._last_logged
    clock.t += 24 * 3600 + 1
    _send(user={"id": "other", "ntfy_enabled": False}, db=SubsDb(1), sender=Sender())
    assert (UID, "task", "task-t1") not in delivery._ATTEMPTS
    assert stale not in delivery._last_logged  # its log marker goes with it


def test_forget_starts_the_key_fresh(clock):
    sender = Sender(ALL_FAIL)
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender)
    delivery.forget(UID, "task", "task-t1")
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender)
    assert len(sender.sent) == 2


# ---- payload -----------------------------------------------------------------------------------------


def test_renotify_is_added_to_the_payload_only_when_asked():
    sender = Sender()
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender, renotify=True)
    _send(user=_user(ntfy=False), db=SubsDb(1), sender=sender)
    assert sender.sent[0]["renotify"] is True and "renotify" not in sender.sent[1]


# ---- push tests --------------------------------------------------------------------------------------


class PushTestDb:
    is_configured = True

    def __init__(self, clear_ok=True):
        self.clear_ok, self.clears, self.reads = clear_ok, [], 0
        self.rows = [{"id": "s-a", "user_id": UID, "endpoint": "https://push.example/a", "p256dh": "k",
                      "auth": "a", "test_requested_at": "2026-10-08T12:00:00+00:00"}]

    def fetch_push_test_requests(self):
        self.reads += 1
        return [dict(r) for r in self.rows]

    def clear_push_test_request(self, sub_id, requested_at):
        self.clears.append((sub_id, requested_at))
        return self.clear_ok


def test_a_push_test_with_the_sender_disabled_is_answered_with_a_failed_row():
    log, db = _history()
    tests = PushTestDb()
    assert process_push_tests(tests, Sender(enabled=False), history=log, answered=set()) == 0
    assert tests.clears == [("s-a", "2026-10-08T12:00:00+00:00")]
    log.flush()
    assert [(r["kind"], r["status"], r["push_state"]) for r in db.rows] == [("test", "failed", "disabled")]


def test_push_tests_record_ok_and_failed_push_states():
    log, db = _history()
    process_push_tests(PushTestDb(), Sender(), history=log, answered=set())
    process_push_tests(PushTestDb(), Sender({"https://push.example/a": PushResult.FAILED}), history=log, answered=set())
    log.flush()
    assert _states(db) == [("sent", "ok"), ("failed", "failed")]


def test_a_failed_flag_clear_never_resends_the_test():
    tests, sender, answered = PushTestDb(clear_ok=False), Sender(), set()
    for _ in range(3):
        process_push_tests(tests, sender, answered=answered)
    assert len(sender.sent) == 1 and len(tests.clears) == 3
    tests.clear_ok = True
    process_push_tests(tests, sender, answered=answered)
    assert answered == set() and len(sender.sent) == 1


# ---- history flush -----------------------------------------------------------------------------------


def test_flush_requeues_unwritten_rows_in_front_and_stays_bounded(monkeypatch, capsys):
    db = LogDb()
    log = NotificationLog(db)
    monkeypatch.setattr(notification_log, "MAX_BUFFERED_ROWS", 5)
    for i in range(4):
        log.record(UID, "task", f"old{i}")
    db.fail = RuntimeError("HTTP 503: down")
    log.flush()
    for i in range(3):
        log.record(UID, "task", f"new{i}")
    assert [r["title"] for r in log._rows][:4] == ["old0", "old1", "old2", "old3"]
    log.flush()
    assert log.pending == 5 and log.dropped == 2  # the oldest rows made room
    assert [r["title"] for r in log._rows] == ["old2", "old3", "new0", "new1", "new2"]
    assert capsys.readouterr().out.count("rows were dropped") == 1
    db.fail = None
    assert log.flush() == 5


def test_a_missing_push_state_column_writes_rows_without_it(capsys):
    class OldSchemaDb(LogDb):
        def insert_notification_log(self, rows):
            if any("push_state" in r for r in rows):
                raise RuntimeError('HTTP 400: {"code":"PGRST204","message":"Could not find the \'push_state\' column"}')
            super().insert_notification_log(rows)

    db = OldSchemaDb()
    log = NotificationLog(db)
    log.record(UID, "task", "T", push_state="ok", delivered=True)
    assert log.flush() == 1
    log.record(UID, "task", "T2", push_state="failed", delivered=False)
    assert log.flush() == 1
    assert [r["status"] for r in db.rows] == ["sent", "failed"] and all("push_state" not in r for r in db.rows)
    assert capsys.readouterr().out.count("push_state does not exist yet") == 1


def test_an_unknown_push_state_is_stored_as_null():
    row = notification_log.build_row(UID, "task", "T", None, None, None, push_ok=0, push_total=0,
                                     ntfy_attempted=False, ntfy_ok=False, created_at=datetime.now(timezone.utc),
                                     push_state="weird")
    assert row["push_state"] is None


# ---- ntfy default topic ------------------------------------------------------------------------------


def test_without_ntfy_topic_the_legacy_path_sends_nothing(monkeypatch, capsys):
    import requests

    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    monkeypatch.setattr(notifier, "_missing_topic_logged", False)
    posted = []
    monkeypatch.setattr(requests, "post", lambda *a, **k: posted.append(a))
    assert notifier.default_topic() == ""
    assert notifier.post_ntfy("T", "B") is False
    assert notifier.post_ntfy("T", "B") is False
    assert posted == []
    assert capsys.readouterr().out.count("NTFY_TOPIC is not set") == 1
    assert not hasattr(notifier, "DEFAULT_NTFY_TOPIC")


# ---- task milestones (notifier) ----------------------------------------------------------------------


class MilestoneStorage:
    def __init__(self):
        self.recorded, self.writes = set(), []

    def has_notified_milestone(self, task_id, milestone):
        return (task_id, milestone) in self.recorded

    def record_milestone(self, task_id, milestone, mirror=True):
        self.writes.append((task_id, milestone))
        self.recorded.add((task_id, milestone))


def _task(hours_left, **extra):
    import time

    t = {"id": "t1", "user_id": UID, "title": "Tarea", "course": "Curso", "due_date_str": "hoy",
         "due_timestamp": int(time.time() + hours_left * 3600), "status": "pending"}
    t.update(extra)
    return t


def _process(tasks, storage, deliver, new=None):
    notifier.TaskNotificationManager.process_milestones(tasks, storage, new_tasks=new, desktop=False, deliver=deliver)


def test_every_milestone_asks_to_renotify_with_its_own_retry_key():
    calls = []
    t = _task(5)
    _process([t], MilestoneStorage(), lambda **k: calls.append(k) or True, new=[t])
    assert [c["renotify"] for c in calls] == [True, True]
    assert [c["retry_key"] for c in calls] == ["task-t1:new", "task-t1:8h"]


def test_countdown_ttls_never_outlive_the_due_date():
    from webpush_sender import TTL_TASK

    calls = []
    t = _task(2)
    _process([t], MilestoneStorage(), lambda **k: calls.append(k) or True, new=[t])
    new, eight = calls
    assert new["ttl"] == TTL_TASK
    assert 60 <= eight["ttl"] <= 2 * 3600
    calls.clear()
    _process([_task(0.001)], MilestoneStorage(), lambda **k: calls.append(k) or True)
    assert calls[0]["ttl"] == 60  # clamped to the minimum


def test_an_overdue_task_is_not_announced_as_new():
    calls = []
    t = _task(-2)
    storage = MilestoneStorage()
    _process([t], storage, lambda **k: calls.append(k) or True, new=[t])
    assert calls == [] and storage.writes == []


def test_larger_milestones_are_not_rerecorded_every_round():
    storage = MilestoneStorage()
    t = _task(5)
    for _ in range(3):
        _process([t], storage, lambda **k: True)
    assert sorted(storage.writes) == sorted([("t1", "8h"), ("t1", "1d"), ("t1", "2d"), ("t1", "3d")])


def test_an_exhausted_milestone_is_recorded_so_it_stops_retrying(clock):
    from functools import partial

    storage = MilestoneStorage()
    sender = Sender(ALL_FAIL)
    deliver = partial(deliver_to_user, _user(ntfy=False), supabase=SubsDb(1), sender=sender)
    t = _task(5)
    t.pop("user_id")  # the user id is taken from the bound deliverer
    for _ in range(300):
        _process([t], storage, deliver)
        if ("t1", "8h") in storage.recorded:
            break
        clock.minutes(1)
    assert ("t1", "8h") in storage.recorded
    assert len(sender.sent) == MAX_ATTEMPTS
    assert not delivery._ATTEMPTS  # given up and forgotten
    _process([t], storage, deliver)
    assert len(sender.sent) == MAX_ATTEMPTS  # never retried again
