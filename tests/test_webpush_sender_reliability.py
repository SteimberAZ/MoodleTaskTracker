"""webpush_sender reliability: error classes, the single retry, safe deletion, host allowlist, payload
extras, the VAPID key guard and the in-memory stats (contract C2)."""
import json
from datetime import datetime, timedelta, timezone

import pytest

pywebpush = pytest.importorskip("pywebpush")
import requests  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402

import webpush_sender as ws  # noqa: E402
from webpush_sender import PushResult, WebPushSender  # noqa: E402

SUBJECT = "mailto:ops@example.org"
ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc-token-0123456789"
KEY = ec.generate_private_key(ec.SECP256R1())
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption()).decode("ascii")
VAPID = ws.load_vapid(PEM)
PUBLIC = ws.public_key_b64(VAPID)
SUB_ID = "22222222-aaaa-bbbb-cccc-000000000002"
PAYLOAD = {"title": "Tarea", "body": "Cuerpo", "url": "/tareas/1", "tag": "task-1"}


def _ago(**delta):
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat()


class FakeDb:
    def __init__(self, reason_supported=None):
        self.updates, self.deletes = [], []
        if reason_supported is not None:
            self.push_failure_reason_supported = reason_supported

    def update_push_subscription(self, sub_id, fields):
        self.updates.append((sub_id, dict(fields)))
        return True

    def delete_push_subscription(self, sub_id):
        self.deletes.append(sub_id)
        return True


class Resp:
    def __init__(self, status=201, text="", headers=None):
        self.status_code, self.text, self.reason, self.headers = status, text, "reason", headers or {}


def _http_error(status, text="{}", headers=None):
    return pywebpush.WebPushException(f"Push failed: {status}", response=Resp(status, text, headers))


def _sub(**over):
    sub = {"id": SUB_ID, "endpoint": ENDPOINT, "p256dh": "p", "auth": "a", "failure_count": 0}
    sub.update(over)
    return sub


class Sleeps(list):
    def __call__(self, seconds):
        self.append(seconds)


def _sender(db=None):
    sleeps = Sleeps()
    sender = WebPushSender(FakeDb() if db is None else db, vapid=VAPID, subject=SUBJECT, lib=pywebpush,
                           sleep=sleeps)
    return sender, sleeps


@pytest.fixture
def push(monkeypatch):
    """Replaces pywebpush.webpush; ``push.outcomes`` is consumed one per call (the last one repeats)."""

    class Push:
        outcomes = [Resp(201)]
        calls = []

    Push.outcomes, Push.calls = [Resp(201)], []

    def fake(**kwargs):
        Push.calls.append(kwargs)
        outcome = Push.outcomes.pop(0) if len(Push.outcomes) > 1 else Push.outcomes[0]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(pywebpush, "webpush", fake)
    return Push


# ---- transient errors: one bounded retry, never counted ----------------------------------------------


def test_429_then_ok_on_the_retry_is_ok_without_counting(push):
    db = FakeDb()
    sender, sleeps = _sender(db)
    push.outcomes = [_http_error(429), Resp(201)]
    sub = _sub(failure_count=3)
    assert sender.send_push(sub, PAYLOAD) is PushResult.OK
    assert len(push.calls) == 2 and sleeps == [ws.DEFAULT_RETRY_DELAY_SECONDS]
    (_, fields), = db.updates
    assert fields["failure_count"] == 0 and "last_success_at" in fields  # the success resets the streak
    assert db.deletes == []
    stats = sender.stats_snapshot()
    assert stats["sent_ok"] == 1 and stats["failed"] == 0 and stats["retried"] == 1


def test_503_twice_fails_once_retried_and_keeps_the_counter(push):
    db = FakeDb()
    sender, sleeps = _sender(db)
    push.outcomes = [_http_error(503)]
    sub = _sub(failure_count=9, last_success_at=_ago(days=30))
    assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert len(push.calls) == 2 and len(sleeps) == 1
    assert sub["failure_count"] == 9 and db.deletes == []
    (_, fields), = db.updates
    assert set(fields) == {"last_failure_at"}  # observability only; failure_count untouched
    stats = sender.stats_snapshot()
    assert stats["failed"] == 1 and stats["transient"] == 1


@pytest.mark.parametrize("header, expected", [
    ("2", 2.0),
    ("0", 0.0),
    ("5", 5.0),
    ("30", ws.DEFAULT_RETRY_DELAY_SECONDS),  # longer than the cap: the default, never a long wait
    ("Wed, 21 Oct 2026 07:28:00 GMT", ws.DEFAULT_RETRY_DELAY_SECONDS),
    ("-3", ws.DEFAULT_RETRY_DELAY_SECONDS),
    (None, ws.DEFAULT_RETRY_DELAY_SECONDS),
])
def test_retry_after_is_honoured_only_up_to_five_seconds(push, header, expected):
    sender, sleeps = _sender()
    headers = {} if header is None else {"Retry-After": header}
    push.outcomes = [_http_error(429, headers=headers), Resp(201)]
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.OK
    assert sleeps == [expected]


def test_retry_after_header_lookup_is_case_insensitive_with_requests_headers(push):
    sender, sleeps = _sender()
    headers = requests.structures.CaseInsensitiveDict({"retry-after": "3"})
    push.outcomes = [_http_error(503, headers=headers), Resp(201)]
    sender.send_push(_sub(), PAYLOAD)
    assert sleeps == [3.0]


def test_a_retry_that_answers_410_is_gone(push):
    db = FakeDb()
    sender, _ = _sender(db)
    push.outcomes = [_http_error(500), _http_error(410)]
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.GONE
    assert db.deletes == [SUB_ID]


def test_a_burst_of_transient_errors_never_deletes_a_row(push):
    db = FakeDb()
    sender, _ = _sender(db)
    push.outcomes = [_http_error(502)]
    sub = _sub(failure_count=50, created_at=_ago(days=400))
    for _ in range(3 * ws.MAX_FAILURES):
        assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert db.deletes == [] and sub["failure_count"] == 50


def test_network_errors_are_not_retried_nor_counted_but_show_in_stats(push):
    db = FakeDb()
    sender, sleeps = _sender(db)
    push.outcomes = [requests.ConnectionError("down")]
    assert sender.send_push(_sub(failure_count=9), PAYLOAD) is PushResult.FAILED
    assert len(push.calls) == 1 and sleeps == []
    assert db.updates == [] and db.deletes == []
    stats = sender.stats_snapshot()
    assert stats["transient"] == 1 and stats["failed"] == 1
    assert stats["last_error"] == "ConnectionError @ fcm.googleapis.com"


# ---- our own mistakes: loud, never counted ------------------------------------------------------------


@pytest.mark.parametrize("status", [400, 401, 403, 413])
def test_server_side_statuses_are_logged_loudly_and_never_counted(push, status, capsys):
    db = FakeDb()
    sender, sleeps = _sender(db)
    body = '{"reason":"BadJwtToken","endpoint":"' + ENDPOINT + '"} ' + "x" * 400
    push.outcomes = [_http_error(status, text=body)]
    sub = _sub(failure_count=9, last_success_at=_ago(days=30))
    for _ in range(ws.MAX_FAILURES + 1):
        assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert sleeps == [] and db.deletes == [] and sub["failure_count"] == 9
    assert all(set(fields) == {"last_failure_at"} for _, fields in db.updates)
    out = capsys.readouterr().out
    line = next(line for line in out.splitlines() if line.startswith("[WebPush] ERROR"))
    assert line.startswith(f"[WebPush] ERROR status={status} host=fcm.googleapis.com hint=")
    hint = line.split("hint=", 1)[1]
    assert len(hint) <= ws.MAX_HINT_CHARS and "BadJwtToken" in hint
    assert "abc-token" not in out  # the capability URL never reaches the logs
    stats = sender.stats_snapshot()
    assert stats["server_errors"] == {status: ws.MAX_FAILURES + 1}
    assert stats["failed"] == ws.MAX_FAILURES + 1 and stats["transient"] == 0


@pytest.mark.parametrize("status", [402, 406, 409, 422])
def test_other_statuses_still_count_against_the_subscription(push, status):
    db = FakeDb()
    sender, sleeps = _sender(db)
    push.outcomes = [_http_error(status)]
    sub = _sub(failure_count=2)
    assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert sleeps == [] and sub["failure_count"] == 3
    (_, fields), = db.updates
    assert fields["failure_count"] == 3 and "last_failure_at" in fields


# ---- deletion guard ----------------------------------------------------------------------------------


def test_ten_counted_failures_with_a_recent_success_do_not_delete(push, capsys):
    db = FakeDb()
    sender, _ = _sender(db)
    push.outcomes = [_http_error(422)]
    sub = _sub(failure_count=9, last_success_at=_ago(hours=1), created_at=_ago(days=90))
    assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert db.deletes == [] and sub["failure_count"] == 10
    assert db.updates[-1][1]["failure_count"] == 10
    assert "kept" in capsys.readouterr().out


@pytest.mark.parametrize("stamp", [
    _ago(days=8),
    _ago(days=8).replace("+00:00", "Z"),
    (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-1] + "+00:00",  # 5 digits
    (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%d %H:%M:%S"),  # naive, space separated
], ids=["iso", "zulu", "five-digit-fraction", "naive-space"])
def test_counted_failures_with_an_old_success_delete_the_row(push, stamp):
    db = FakeDb()
    sender, _ = _sender(db)
    push.outcomes = [_http_error(422)]
    assert sender.send_push(_sub(failure_count=9, last_success_at=stamp), PAYLOAD) is PushResult.FAILED
    assert db.deletes == [SUB_ID]


def test_a_never_delivered_row_falls_back_to_its_creation_time(push):
    db = FakeDb()
    sender, _ = _sender(db)
    push.outcomes = [_http_error(422)]
    sender.send_push(_sub(failure_count=9, last_success_at=None, created_at=_ago(days=2)), PAYLOAD)
    assert db.deletes == []
    sender.send_push(_sub(failure_count=9, last_success_at=None, created_at=_ago(days=10)), PAYLOAD)
    assert db.deletes == [SUB_ID]


def test_missing_or_unreadable_timestamps_never_delete_and_log_once(push, capsys):
    db = FakeDb()
    sender, _ = _sender(db)
    push.outcomes = [_http_error(422)]
    for stamp in (None, "not a date"):
        for _ in range(3):
            sub = _sub(failure_count=20, last_success_at=stamp)
            assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert db.deletes == []
    assert capsys.readouterr().out.count("carry no last_success_at") == 1


def test_404_still_deletes_immediately(push):
    db = FakeDb()
    sender, sleeps = _sender(db)
    push.outcomes = [_http_error(404)]
    assert sender.send_push(_sub(last_success_at=_ago(minutes=1)), PAYLOAD) is PushResult.GONE
    assert db.deletes == [SUB_ID] and db.updates == [] and sleeps == []
    assert sender.stats_snapshot()["gone"] == 1


# ---- endpoint allowlist ------------------------------------------------------------------------------


@pytest.mark.parametrize("endpoint", [
    "https://random.push.apple.com/x",
    "http://fcm.googleapis.com/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://169.254.169.254/latest/meta-data",
    "https://notify.windows.com/x",  # the bare suffix is not a WNS host
    "ftp://web.push.apple.com/x",
    "not a url",
])
def test_non_allowlisted_endpoints_are_gone_and_deleted_without_a_request(push, endpoint, capsys):
    db = FakeDb()
    sender, _ = _sender(db)
    assert sender.send_push(_sub(endpoint=endpoint), PAYLOAD) is PushResult.GONE
    assert push.calls == [] and db.deletes == [SUB_ID]
    assert capsys.readouterr().out.count("[WebPush] dropping subscription with non-allowlisted host") == 1
    assert sender.stats_snapshot()["gone"] == 1


@pytest.mark.parametrize("endpoint", [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/QF-x",
    "https://wns2-par02p.notify.windows.com/w/?token=x",
    "https://FCM.googleapis.com/fcm/send/x",
])
def test_known_push_services_are_allowed(push, endpoint):
    sender, _ = _sender()
    assert sender.send_push(_sub(endpoint=endpoint), PAYLOAD) is PushResult.OK
    assert len(push.calls) == 1


def test_the_allowlist_mirrors_the_web_app():
    assert ws.ALLOWED_PUSH_HOSTS == ("fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com")
    assert ws.ALLOWED_PUSH_HOST_SUFFIXES == (".notify.windows.com",)


# ---- payload extras ----------------------------------------------------------------------------------


def test_renotify_true_is_sent_and_false_or_absent_is_omitted():
    assert json.loads(ws.encode_payload({**PAYLOAD, "renotify": True}))["renotify"] is True
    assert "renotify" not in json.loads(ws.encode_payload({**PAYLOAD, "renotify": False}))
    assert "renotify" not in json.loads(ws.encode_payload({**PAYLOAD, "renotify": "yes"}))  # bool only
    assert "renotify" not in json.loads(ws.encode_payload(PAYLOAD))


def test_timestamp_is_passed_through_or_set_to_now():
    assert json.loads(ws.encode_payload({**PAYLOAD, "timestamp": 1_700_000_000_123}))["timestamp"] == 1_700_000_000_123
    before = int(datetime.now(timezone.utc).timestamp() * 1000)
    stamp = json.loads(ws.encode_payload(PAYLOAD))["timestamp"]
    assert before - 5 <= stamp <= before + 5_000
    for bad in (None, True, "soon", -1, 0):
        assert json.loads(ws.encode_payload({**PAYLOAD, "timestamp": bad}))["timestamp"] >= before


def test_a_near_limit_payload_drops_the_timestamp_first_and_keeps_tag_url_and_renotify():
    base = {**PAYLOAD, "renotify": True, "timestamp": 1_700_000_000_123, "body": ""}
    empty = len(ws.encode_payload(base).encode("utf-8"))
    body = "x" * (ws.MAX_PAYLOAD_BYTES - empty + 5)  # fits only once the timestamp is gone
    text = ws.encode_payload({**base, "body": body})
    data = json.loads(text)
    assert len(text.encode("utf-8")) <= ws.MAX_PAYLOAD_BYTES
    assert "timestamp" not in data and data["body"] == body  # the whole body survived
    assert data["tag"] == "task-1" and data["url"] == "/tareas/1" and data["renotify"] is True

    longer = ws.encode_payload({**base, "body": "y" * 10_000})
    data = json.loads(longer)
    assert len(longer.encode("utf-8")) <= ws.MAX_PAYLOAD_BYTES
    assert data["body"].endswith("…") and data["tag"] == "task-1" and data["renotify"] is True


def test_the_payload_sent_carries_renotify(push):
    sender, _ = _sender()
    sender.send_push(_sub(), {**PAYLOAD, "renotify": True, "timestamp": 42})
    data = json.loads(push.calls[0]["data"])
    assert data["renotify"] is True and data["timestamp"] == 42


# ---- last_failure_reason -----------------------------------------------------------------------------


@pytest.mark.parametrize("status", [503, 403, 422])
def test_last_failure_reason_is_sent_only_when_the_client_supports_it(push, status):
    push.outcomes = [_http_error(status, text="Service says " + "z" * 300)]
    plain = FakeDb()
    _sender(plain)[0].send_push(_sub(), PAYLOAD)
    assert all("last_failure_reason" not in fields for _, fields in plain.updates)

    off = FakeDb(reason_supported=False)
    _sender(off)[0].send_push(_sub(), PAYLOAD)
    assert all("last_failure_reason" not in fields for _, fields in off.updates)

    on = FakeDb(reason_supported=True)
    _sender(on)[0].send_push(_sub(), PAYLOAD)
    (_, fields), = on.updates
    reason = fields["last_failure_reason"]
    assert reason.startswith(f"HTTP {status}") and len(reason) <= ws.MAX_REASON_CHARS


# ---- key guard and public key ------------------------------------------------------------------------


def test_expected_public_key_mismatch_disables_the_sender_without_key_material(tmp_path):
    other = ws.public_key_b64(ws.load_vapid(ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode("ascii")))
    env = {"VAPID_PRIVATE_KEY": PEM, "VAPID_SUBJECT": SUBJECT, "VAPID_PUBLIC_KEY_EXPECTED": f"  {other}\n"}
    sender = WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path))
    assert sender.enabled is False and sender.public_key_b64 is None
    assert sender.status == "Web Push: disabled (VAPID public key does not match VAPID_PUBLIC_KEY_EXPECTED)"
    for secret in (PUBLIC, other, PEM.splitlines()[1]):
        assert secret not in sender.status


@pytest.mark.parametrize("expected", ["", "   ", PUBLIC, f" {PUBLIC} ", PUBLIC + "="])
def test_a_matching_or_unset_expected_key_keeps_the_sender_enabled(tmp_path, expected):
    env = {"VAPID_PRIVATE_KEY": PEM, "VAPID_SUBJECT": SUBJECT, "VAPID_PUBLIC_KEY_EXPECTED": expected}
    sender = WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path))
    assert sender.enabled is True and sender.public_key_b64 == PUBLIC


def test_public_key_is_exposed_only_by_an_enabled_sender():
    assert _sender()[0].public_key_b64 == PUBLIC
    assert WebPushSender(FakeDb()).public_key_b64 is None


# ---- stats -------------------------------------------------------------------------------------------


def test_stats_snapshot_counts_every_outcome_and_resets(push):
    sender, _ = _sender()
    push.outcomes = [Resp(201)]
    sender.send_push(_sub(), PAYLOAD)
    sender.send_push(_sub(), PAYLOAD)
    push.outcomes = [_http_error(410)]
    sender.send_push(_sub(), PAYLOAD)
    push.outcomes = [_http_error(500)]
    sender.send_push(_sub(), PAYLOAD)
    push.outcomes = [_http_error(403)]
    sender.send_push(_sub(), PAYLOAD)
    sender.send_push(_sub(), PAYLOAD)
    push.outcomes = [_http_error(422)]
    sender.send_push(_sub(), PAYLOAD)

    snap = sender.stats_snapshot(reset=False)
    assert snap["sent_ok"] == 2 and snap["gone"] == 1 and snap["failed"] == 4
    assert snap["transient"] == 1 and snap["retried"] == 1 and snap["server_errors"] == {403: 2}
    assert snap["last_error"] == "HTTP 422 @ fcm.googleapis.com"
    assert datetime.fromisoformat(snap["last_ok_at"]).tzinfo is not None
    assert snap["last_error_at"]
    assert "abc-token" not in json.dumps(snap)  # JSON-safe and free of capability URLs

    snap["server_errors"][403] = 99  # a snapshot is a copy
    assert sender.stats_snapshot()["server_errors"] == {403: 2}  # reset=True by default

    after = sender.stats_snapshot()
    assert (after["sent_ok"], after["failed"], after["gone"], after["transient"], after["server_errors"]) == (0, 0, 0, 0, {})
    assert after["last_ok_at"] == snap["last_ok_at"]  # "last seen" values survive a reset


def test_a_disabled_sender_counts_nothing():
    sender = WebPushSender(FakeDb())
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.FAILED
    snap = sender.stats_snapshot()
    assert snap["failed"] == 0 and snap["last_ok_at"] is None and snap["last_error"] is None


def test_the_default_sleep_is_time_sleep():
    import time

    assert WebPushSender(FakeDb()).sleep is time.sleep


def test_sending_never_raises_even_when_the_sleep_does(push):
    def boom(_):
        raise KeyboardInterrupt  # not an Exception: must propagate (the worker is being stopped)

    sender = WebPushSender(FakeDb(), vapid=VAPID, subject=SUBJECT, lib=pywebpush, sleep=lambda _: 1 / 0)
    push.outcomes = [_http_error(503), Resp(201)]
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.OK
    interrupted = WebPushSender(FakeDb(), vapid=VAPID, subject=SUBJECT, lib=pywebpush, sleep=boom)
    push.outcomes = [_http_error(503), Resp(201)]
    with pytest.raises(KeyboardInterrupt):
        interrupted.send_push(_sub(), PAYLOAD)

