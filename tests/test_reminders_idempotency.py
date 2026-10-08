"""pkg-delivery-core: custom and class reminders are delivered once, stop when done, never retry forever."""
from datetime import datetime, timedelta, timezone
from functools import partial

import pytest

import delivery
import worker
from custom_reminders import decide_action, process_due_reminders
from delivery import deliver_to_user
from webpush_sender import PushResult

UTC = timezone.utc
NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
FIRE = "2026-01-01T11:59:00Z"


@pytest.fixture(autouse=True)
def _fresh_state():
    delivery.reset_delivery_state()
    yield
    delivery.reset_delivery_state()


def _reminder(**over):
    r = {"id": "r1", "title": "Drink water", "message": None, "interval_minutes": 60,
         "starts_at": "2026-01-01T00:00:00Z", "ends_at": "2026-01-02T00:00:00Z", "next_fire_at": FIRE,
         "active": True, "user_id": "u1",
         "moodle_users": {"ntfy_topic": "utm-owner1", "active": True, "ntfy_enabled": False}}
    r.update(over)
    return r


class ConditionalDb:
    """A reminders table whose update_reminder has the conditional contract (C4)."""

    is_configured = True

    def __init__(self, rows, results=None):
        self.rows = {r["id"]: dict(r) for r in rows}
        self.results = list(results or [])  # forced answers, consumed in order; then a real update
        self.updates = []

    def fetch_due_reminders(self, now_iso):
        return [dict(r) for r in self.rows.values() if r.get("active", True)]

    def update_reminder(self, rid, fields, expected_next_fire_at=None):
        self.updates.append((rid, dict(fields), expected_next_fire_at))
        if self.results:
            return self.results.pop(0)
        row = self.rows.get(rid)
        if row is None or (expected_next_fire_at is not None and row["next_fire_at"] != expected_next_fire_at):
            return None
        row.update(fields)
        return True


def to_iso_str(dt):
    return dt.astimezone(UTC).isoformat()


def _sender_counter():
    calls = []
    return calls, (lambda owner, rem, title, body: calls.append(rem["next_fire_at"]) or True)


def test_a_failed_update_is_retried_and_never_delivers_twice():
    db = ConditionalDb([_reminder()], results=[False, False])
    calls, deliver = _sender_counter()
    pending = {}
    assert process_due_reminders(db, deliver=deliver, now=NOW, unpatched=pending) == 1
    assert pending and db.updates[0][2] == FIRE  # conditional on the delivered fire time
    assert process_due_reminders(db, deliver=deliver, now=NOW, unpatched=pending) == 0  # retry fails again
    assert process_due_reminders(db, deliver=deliver, now=NOW, unpatched=pending) == 0  # retry lands
    assert pending == {} and calls == [FIRE]
    assert db.rows["r1"]["next_fire_at"] == "2026-01-01T12:59:00+00:00"
    assert len(db.updates) == 3 and db.updates[1][1] == db.updates[0][1]


def test_a_lost_race_is_not_resent(capsys):
    db = ConditionalDb([_reminder()], results=[None])
    calls, deliver = _sender_counter()
    pending = {}
    assert process_due_reminders(db, deliver=deliver, now=NOW, unpatched=pending) == 1
    assert pending == {} and "row changed meanwhile" in capsys.readouterr().out
    assert calls == [FIRE]


def test_the_pending_patch_is_retried_even_when_the_row_is_no_longer_due():
    db = ConditionalDb([_reminder()], results=[False])
    calls, deliver = _sender_counter()
    pending = {}
    process_due_reminders(db, deliver=deliver, now=NOW, unpatched=pending)
    db.rows["r1"]["active"] = False  # e.g. not returned by the due query any more
    process_due_reminders(db, deliver=deliver, now=NOW, unpatched=pending)
    assert pending == {} and len(db.updates) == 2


@pytest.mark.parametrize("task", [{"status": "submitted", "is_dismissed": False}, {"status": "pending", "is_dismissed": 1}])
def test_a_reminder_linked_to_a_finished_task_stops_without_sending(task):
    db = ConditionalDb([_reminder(task=task)])
    calls, deliver = _sender_counter()
    assert process_due_reminders(db, deliver=deliver, now=NOW, unpatched={}) == 0
    assert calls == [] and db.rows["r1"]["active"] is False


@pytest.mark.parametrize("task", [None, {"status": "pending", "is_dismissed": False}])
def test_a_missing_or_open_task_keeps_the_reminder_going(task):
    assert decide_action(_reminder(task=task), NOW)["action"] == "send"


class SubsDb:
    is_configured = True

    def fetch_push_subscriptions(self, user_id):
        return [{"id": "s1", "endpoint": "https://push.example/1", "p256dh": "k", "auth": "a"}]


class Sender:
    enabled = True

    def __init__(self, ok=False):
        self.ok, self.sent = ok, 0

    def send_push(self, sub, payload, ttl, urgency):
        self.sent += 1
        return PushResult.OK if self.ok else PushResult.FAILED


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def _real_deliverer(sender):
    return worker.reminder_deliverer(partial(deliver_to_user, supabase=SubsDb(), sender=sender))


def test_an_exhausted_reminder_moves_on_to_its_next_occurrence(monkeypatch):
    clock = Clock(NOW.timestamp())
    monkeypatch.setattr(delivery, "_now", clock)
    sender = Sender(ok=False)
    db = ConditionalDb([_reminder()])
    deliver = _real_deliverer(sender)
    pending = {}
    now = NOW
    for _ in range(300):
        process_due_reminders(db, deliver=deliver, now=now, unpatched=pending)
        if db.rows["r1"]["next_fire_at"] != FIRE:
            break
        now += timedelta(minutes=1)
        clock.t = now.timestamp()
    assert sender.sent == delivery.MAX_ATTEMPTS
    row = db.rows["r1"]
    assert row["next_fire_at"] > to_iso_str(now) and "last_sent_at" not in row and row.get("active", True)
    assert delivery.pending_attempts("u1", "reminder", "reminder-r1") == 0  # the next fire starts fresh


def test_an_exhausted_one_shot_reminder_is_deactivated(monkeypatch):
    clock = Clock(NOW.timestamp())
    monkeypatch.setattr(delivery, "_now", clock)
    db = ConditionalDb([_reminder(interval_minutes=60 * 24 * 30, ends_at="2026-01-20T00:00:00Z")])
    deliver = _real_deliverer(Sender(ok=False))
    now = NOW
    for _ in range(300):
        process_due_reminders(db, deliver=deliver, now=now, unpatched={})
        if db.rows["r1"].get("active") is False:
            break
        now += timedelta(minutes=1)
        clock.t = now.timestamp()
    assert db.rows["r1"]["active"] is False and "last_sent_at" not in db.rows["r1"]


def test_an_end_date_passing_during_backoff_still_gets_the_retry(monkeypatch):
    clock = Clock(NOW.timestamp())
    monkeypatch.setattr(delivery, "_now", clock)
    sender = Sender(ok=False)
    db = ConditionalDb([_reminder(ends_at="2026-01-01T12:00:30Z")])
    deliver = _real_deliverer(sender)
    process_due_reminders(db, deliver=deliver, now=NOW, unpatched={})
    assert sender.sent == 1
    later = NOW + timedelta(minutes=2)  # past ends_at, after the first backoff
    clock.t = later.timestamp()
    sender.ok = True
    assert process_due_reminders(db, deliver=deliver, now=later, unpatched={}) == 1
    assert sender.sent == 2 and db.rows["r1"]["active"] is False and db.rows["r1"]["last_sent_at"]


def test_an_end_date_that_passed_without_any_attempt_expires_with_a_log(capsys):
    db = ConditionalDb([_reminder(ends_at="2026-01-01T11:59:30Z")])
    calls, deliver = _sender_counter()
    assert process_due_reminders(db, deliver=deliver, now=NOW, unpatched={}) == 0
    assert calls == [] and db.rows["r1"]["active"] is False
    assert "ended before its fire time" in capsys.readouterr().out


def test_the_owner_carries_ntfy_confirmed_at_when_the_embed_has_it():
    seen = []
    users = {"ntfy_topic": "utm-o", "active": True, "ntfy_enabled": True, "ntfy_confirmed_at": "2026-01-01T00:00:00Z"}
    db = ConditionalDb([_reminder(moodle_users=users)])
    process_due_reminders(db, deliver=lambda owner, *a: seen.append(owner) or True, now=NOW, unpatched={})
    assert seen[0]["ntfy_confirmed_at"] == "2026-01-01T00:00:00Z" and seen[0]["ntfy_enabled"] is True
