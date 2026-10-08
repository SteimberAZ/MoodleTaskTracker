from datetime import datetime, timedelta, timezone

import pytest

from custom_reminders import (
    compute_next_fire,
    decide_action,
    parse_timestamptz,
    process_due_reminders,
)

UTC = timezone.utc
NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    "raw",
    [
        "2026-01-01T12:00:00Z",
        "2026-01-01T12:00:00+00:00",
        "2026-01-01T12:00:00+00",
        "2026-01-01 12:00:00+00",
        "2026-01-01T07:00:00-05:00",
        "2026-01-01T12:00:00",
    ],
)
def test_parse_timestamptz_variants(raw):
    assert parse_timestamptz(raw) == NOW


def test_parse_timestamptz_fractional_seconds():
    dt = parse_timestamptz("2026-01-01T12:00:00.123Z")
    assert dt == NOW + timedelta(milliseconds=123)
    dt = parse_timestamptz("2026-01-01T12:00:00.1234567+00:00")
    assert dt.microsecond == 123456


def test_parse_timestamptz_invalid():
    with pytest.raises(ValueError):
        parse_timestamptz("not a date")


def test_compute_next_fire_future_is_unchanged():
    nxt = NOW + timedelta(minutes=3)
    assert compute_next_fire(nxt, 10, NOW) == nxt


def test_compute_next_fire_exactly_due_advances_one_interval():
    assert compute_next_fire(NOW, 10, NOW) == NOW + timedelta(minutes=10)


def test_compute_next_fire_skips_missed_intervals():
    past = NOW - timedelta(minutes=95)
    result = compute_next_fire(past, 10, NOW)
    assert result == NOW + timedelta(minutes=5)
    assert result > NOW


def test_compute_next_fire_rejects_bad_interval():
    with pytest.raises(ValueError):
        compute_next_fire(NOW, 0, NOW)


def _reminder(**over):
    r = {
        "id": "r1",
        "title": "Drink water",
        "message": None,
        "interval_minutes": 60,
        "starts_at": "2026-01-01T00:00:00Z",
        "ends_at": "2026-01-02T00:00:00Z",
        "next_fire_at": "2026-01-01T11:59:00Z",
        "active": True,
        "user_id": "u1",
        "moodle_users": {"ntfy_topic": "utm-owner1", "active": True},
    }
    r.update(over)
    return r


def test_decide_skip_when_not_due():
    d = decide_action(_reminder(next_fire_at="2026-01-01T12:30:00Z"), NOW)
    assert d == {"action": "skip", "patch": {}}


def test_decide_skip_on_malformed_row():
    assert decide_action(_reminder(next_fire_at="garbage"), NOW)["action"] == "skip"
    assert decide_action({"id": "x"}, NOW)["action"] == "skip"


def test_decide_expire_after_end():
    d = decide_action(_reminder(ends_at="2026-01-01T11:00:00Z"), NOW)
    assert d["action"] == "expire"
    assert d["patch"]["active"] is False
    assert "last_sent_at" not in d["patch"]


def test_decide_send_advances_and_stays_active():
    d = decide_action(_reminder(), NOW)
    assert d["action"] == "send"
    p = d["patch"]
    assert p["last_sent_at"] == NOW.isoformat()
    assert p["updated_at"] == NOW.isoformat()
    assert parse_timestamptz(p["next_fire_at"]) == datetime(2026, 1, 1, 12, 59, tzinfo=UTC)
    assert "active" not in p


def test_decide_send_deactivates_when_next_fire_past_end():
    d = decide_action(_reminder(ends_at="2026-01-01T12:30:00Z"), NOW)
    assert d["action"] == "send"
    assert d["patch"]["active"] is False


class FakeClient:
    is_configured = True

    def __init__(self, rows):
        self.rows = rows
        self.updates = []

    def fetch_due_reminders(self, now_iso):
        return self.rows

    def update_reminder(self, rid, fields):
        self.updates.append((rid, fields))
        return True


def test_process_sends_and_patches():
    client = FakeClient([_reminder(message="Hydrate now")])
    sent = []
    n = process_due_reminders(client, lambda t, b, topic: sent.append((t, b, topic)) or True, now=NOW)
    assert n == 1
    assert sent == [("Drink water", "Hydrate now", "utm-owner1")]
    assert client.updates[0][0] == "r1"


def test_process_body_falls_back_to_title():
    client = FakeClient([_reminder()])
    sent = []
    process_due_reminders(client, lambda t, b, topic: sent.append((t, b)) or True, now=NOW)
    assert sent == [("Drink water", "Drink water")]


def test_process_expired_does_not_send():
    client = FakeClient([_reminder(ends_at="2026-01-01T11:00:00Z")])
    sent = []
    n = process_due_reminders(client, lambda t, b, topic: sent.append(t) or True, now=NOW)
    assert n == 0 and sent == []
    assert client.updates[0][1]["active"] is False


def test_process_failed_send_leaves_row_untouched():
    client = FakeClient([_reminder()])
    n = process_due_reminders(client, lambda t, b, topic: False, now=NOW)
    assert n == 0 and client.updates == []


def test_process_unconfigured_client_is_noop():
    client = FakeClient([_reminder()])
    client.is_configured = False
    assert process_due_reminders(client, lambda t, b, topic: True, now=NOW) == 0


def test_each_reminder_goes_to_its_own_owner_topic():
    client = FakeClient([
        _reminder(id="a", user_id="ua", moodle_users={"ntfy_topic": "utm-aaaa", "active": True}),
        _reminder(id="b", user_id="ub", moodle_users={"ntfy_topic": "utm-bbbb", "active": True}),
    ])
    sent = []
    n = process_due_reminders(client, lambda t, b, topic: sent.append(topic) or True, now=NOW)
    assert n == 2 and sent == ["utm-aaaa", "utm-bbbb"]
    assert [rid for rid, _ in client.updates] == ["a", "b"]


@pytest.mark.parametrize(
    "over",
    [
        {"user_id": None, "moodle_users": None},  # orphan reminder (pre multi-user)
        {"user_id": None},  # no owner id even if something got joined
        {"moodle_users": None},  # owner row not visible
        {"moodle_users": {"ntfy_topic": "utm-zzzz", "active": False}},  # inactive user
        {"moodle_users": {"ntfy_topic": "", "active": True}},  # no topic
        {"moodle_users": []},  # unexpected embed shape
    ],
)
def test_reminders_without_active_owner_are_skipped_and_left_untouched(over):
    client = FakeClient([_reminder(**over)])
    sent = []
    n = process_due_reminders(client, lambda t, b, topic: sent.append(topic) or True, now=NOW)
    assert n == 0 and sent == [] and client.updates == []


def test_one_skipped_reminder_does_not_block_the_next():
    client = FakeClient([
        _reminder(id="x", user_id=None, moodle_users=None),
        _reminder(id="y"),
    ])
    sent = []
    assert process_due_reminders(client, lambda t, b, topic: sent.append(topic) or True, now=NOW) == 1
    assert sent == ["utm-owner1"]


class FlakyPatchClient(FakeClient):
    """The GET works but the PATCH fails until ``patch_ok`` is set."""

    def __init__(self, rows):
        super().__init__(rows)
        self.patch_ok = False

    def update_reminder(self, rid, fields):
        self.updates.append((rid, fields))
        return self.patch_ok


def test_a_failed_patch_after_delivery_is_retried_without_resending():
    client = FlakyPatchClient([_reminder()])
    sent, pending = [], {}
    send = lambda t, b, topic: sent.append(t) or True

    assert process_due_reminders(client, send, now=NOW, unpatched=pending) == 1
    assert ("r1", "2026-01-01T11:59:00Z") in pending
    # Next ticks: the row is still due (PATCH lost) but nothing is delivered again.
    assert process_due_reminders(client, send, now=NOW, unpatched=pending) == 0
    assert process_due_reminders(client, send, now=NOW, unpatched=pending) == 0
    assert sent == ["Drink water"]
    assert len(client.updates) == 3 and client.updates[1][1] == client.updates[0][1]  # same patch retried

    client.patch_ok = True
    process_due_reminders(client, send, now=NOW, unpatched=pending)
    assert pending == {} and sent == ["Drink water"]


def test_a_row_that_moved_on_is_delivered_again():
    client = FlakyPatchClient([_reminder()])
    sent, pending = [], {}
    send = lambda t, b, topic: sent.append(t) or True
    process_due_reminders(client, send, now=NOW, unpatched=pending)
    client.patch_ok = True
    client.rows = [_reminder(next_fire_at="2026-01-01T11:30:00Z")]  # edited elsewhere, still due
    assert process_due_reminders(client, send, now=NOW, unpatched=pending) == 1
    assert pending == {} and len(sent) == 2
