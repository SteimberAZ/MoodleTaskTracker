"""webpush_sender: VAPID key forms, payload limits, result mapping, subscription health and startup."""
import base64
import json
import os
import sys
import time

import pytest

pywebpush = pytest.importorskip("pywebpush")
http_ece = pytest.importorskip("http_ece")
import requests  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec, rsa  # noqa: E402
from py_vapid import VapidException  # noqa: E402

import webpush_sender as ws  # noqa: E402
from webpush_sender import PushResult, WebPushSender  # noqa: E402

SUBJECT = "mailto:ops@example.org"
ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc-token"


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _pem(key, fmt=serialization.PrivateFormat.PKCS8):
    return key.private_bytes(serialization.Encoding.PEM, fmt, serialization.NoEncryption()).decode("ascii")


def _point(key):
    return key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)


KEY = ec.generate_private_key(ec.SECP256R1())
PUBLIC = _b64(_point(KEY))
VAPID = ws.load_vapid(_pem(KEY))

# A "browser": its subscription keys, so payloads can be decrypted again.
BROWSER_KEY = ec.generate_private_key(ec.SECP256R1())
BROWSER_AUTH = os.urandom(16)
P256DH = _b64(_point(BROWSER_KEY))
AUTH = _b64(BROWSER_AUTH)


class FakeDb:
    def __init__(self, fail=False):
        self.updates, self.deletes, self.fail = [], [], fail

    def update_push_subscription(self, sub_id, fields):
        if self.fail:
            raise RuntimeError("db down")
        self.updates.append((sub_id, fields))
        return True

    def delete_push_subscription(self, sub_id):
        if self.fail:
            raise RuntimeError("db down")
        self.deletes.append(sub_id)
        return True


class Resp:
    """What a push service (or PostgREST) answers."""

    def __init__(self, status=201, text="", payload=None):
        self.status_code, self.text, self.reason, self.headers, self._payload = status, text, "reason", {}, payload

    def json(self):
        return self._payload


def _sub(**over):
    sub = {"id": "11111111-aaaa-bbbb-cccc-000000000001", "endpoint": ENDPOINT,
           "p256dh": P256DH, "auth": AUTH, "failure_count": 0}
    sub.update(over)
    return sub


def _sender(db=None, **kw):
    return WebPushSender(FakeDb() if db is None else db, vapid=VAPID, subject=SUBJECT, lib=pywebpush, **kw)


def _http_error(status, text="{}"):
    return pywebpush.WebPushException(f"Push failed: {status}", response=Resp(status, text))


@pytest.fixture
def push(monkeypatch):
    """Replaces pywebpush.webpush: records every call, then returns or raises ``push.outcome``."""

    class Push:
        outcome = Resp(201)
        calls = []

    Push.calls = []

    def fake(**kwargs):
        Push.calls.append(kwargs)
        if isinstance(Push.outcome, BaseException):
            raise Push.outcome
        return Push.outcome

    monkeypatch.setattr(pywebpush, "webpush", fake)
    return Push


PAYLOAD = {"title": "Tarea", "body": "Cuerpo", "url": "/tareas/1", "tag": "task-1"}


# ---- VAPID key forms ---------------------------------------------------------------------------------


def _forms():
    der = KEY.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    pem = _pem(KEY)
    return {
        "pem": pem,
        "pem with trailing blank lines": pem + "\n\n",
        "pem with CRLF": pem.replace("\n", "\r\n"),
        "pem sec1 (EC PRIVATE KEY)": _pem(KEY, serialization.PrivateFormat.TraditionalOpenSSL),
        "pem on one line with escaped newlines": pem.strip().replace("\n", "\\n"),
        "base64url der": _b64(der),
        "standard base64 der": base64.b64encode(der).decode("ascii"),
        "base64url raw 32-byte scalar": _b64(KEY.private_numbers().private_value.to_bytes(32, "big")),
    }


FORMS = _forms()


@pytest.mark.parametrize("name", list(FORMS))
def test_every_supported_key_form_yields_the_same_public_key(name):
    assert ws.public_key_b64(ws.load_vapid(FORMS[name])) == PUBLIC


def test_public_key_is_the_87_char_base64url_point():
    assert len(PUBLIC) == 87 and "=" not in PUBLIC
    assert len(base64.urlsafe_b64decode(PUBLIC + "=")) == 65


@pytest.mark.parametrize("bad", [
    "",
    "   ",
    "definitely not a key",
    _b64(os.urandom(31)),  # neither a 32-byte scalar nor a DER structure
    _pem(rsa.generate_private_key(65537, 2048)),
    _pem(ec.generate_private_key(ec.SECP384R1())),
], ids=["empty", "blank", "garbage", "31-byte-scalar", "rsa-pem", "p384-pem"])
def test_unusable_keys_are_rejected(bad):
    with pytest.raises(ValueError):
        ws.load_vapid(bad)


# ---- payload -----------------------------------------------------------------------------------------


def test_payload_has_exactly_title_body_url_tag():
    data = json.loads(ws.encode_payload(dict(PAYLOAD, extra="never sent")))
    assert data == PAYLOAD


def test_payload_defaults_url_and_keeps_unicode_intact():
    text = ws.encode_payload({"title": "Notificaciones activas ✅", "body": "Así te llegarán 🚨"})
    assert json.loads(text) == {"title": "Notificaciones activas ✅", "body": "Así te llegarán 🚨", "url": "/", "tag": ""}


LONG_BODIES = {
    "ascii": "x" * 10_000,
    "two-byte": "ñ" * 10_000,
    "four-byte": "🚨" * 5_000,
    "escapes": 'quote " backslash \\ and\nnewline ' * 800,
}


@pytest.mark.parametrize("kind", list(LONG_BODIES))  # ids stay short: a 10 KB id breaks PYTEST_CURRENT_TEST on Windows
def test_long_bodies_are_cut_to_fit_one_push_record(kind):
    body = LONG_BODIES[kind]
    text = ws.encode_payload({**PAYLOAD, "body": body})
    size = len(text.encode("utf-8"))
    assert ws.MAX_PAYLOAD_BYTES - 16 <= size <= ws.MAX_PAYLOAD_BYTES  # cut at the limit, not far below it
    cut = json.loads(text)["body"]
    assert cut.endswith("…") and body.startswith(cut[:-1])


def test_oversized_title_url_and_tag_are_clipped():
    text = ws.encode_payload({"title": "t" * 5000, "body": "b" * 9000, "url": "/" + "u" * 5000, "tag": "g" * 5000})
    data = json.loads(text)
    assert len(data["title"]) == ws.MAX_TITLE_CHARS and len(data["url"]) == ws.MAX_URL_CHARS
    assert len(data["tag"]) == ws.MAX_TAG_CHARS
    assert len(text.encode("utf-8")) <= ws.MAX_PAYLOAD_BYTES


def test_a_short_payload_is_never_touched():
    assert json.loads(ws.encode_payload(PAYLOAD))["body"] == "Cuerpo"


def test_lone_surrogates_cannot_break_encryption():
    text = ws.encode_payload({**PAYLOAD, "title": "a" + chr(0xD800) + "b"})
    text.encode("utf-8")  # would raise UnicodeEncodeError if a surrogate survived


# ---- result mapping and subscription health ------------------------------------------------------------


def test_accepted_push_is_ok_marks_success_and_builds_the_right_request(push):
    db = FakeDb()
    sender = _sender(db)
    assert sender.send_push(_sub(failure_count=4), PAYLOAD, ttl=600, urgency="high") is PushResult.OK

    (call,) = push.calls
    assert call["subscription_info"] == {"endpoint": ENDPOINT, "keys": {"p256dh": P256DH, "auth": AUTH}}
    assert json.loads(call["data"]) == PAYLOAD
    assert call["vapid_private_key"] is VAPID
    assert call["vapid_claims"] == {"sub": SUBJECT}
    assert call["ttl"] == 600 and call["headers"] == {"Urgency": "high"}
    assert call["timeout"] == ws.SEND_TIMEOUT_SECONDS  # pywebpush would otherwise wait forever
    (sub_id, fields), = db.updates
    assert sub_id == "11111111-aaaa-bbbb-cccc-000000000001"
    assert fields["failure_count"] == 0 and fields["last_success_at"].endswith("+00:00")
    assert db.deletes == []


@pytest.mark.parametrize("status", [201, 200, 202])
def test_every_2xx_accepted_by_pywebpush_counts_as_ok(push, status):
    push.outcome = Resp(status)
    assert _sender().send_push(_sub(), PAYLOAD) is PushResult.OK


@pytest.mark.parametrize("status", [404, 410])
def test_404_and_410_mean_gone_and_delete_the_row(push, status):
    db = FakeDb()
    push.outcome = _http_error(status)
    assert _sender(db).send_push(_sub(), PAYLOAD) is PushResult.GONE
    assert db.deletes == ["11111111-aaaa-bbbb-cccc-000000000001"]
    assert db.updates == []


@pytest.mark.parametrize("status", [400, 413, 422])
def test_subscription_http_errors_fail_and_increment_the_counter(push, status):
    db = FakeDb()
    push.outcome = _http_error(status, text='{"reason":"BadRequest"}')
    sub = _sub(failure_count=3)
    assert _sender(db).send_push(sub, PAYLOAD) is PushResult.FAILED
    (sub_id, fields), = db.updates
    assert fields["failure_count"] == 4 and fields["last_failure_at"].endswith("+00:00")
    assert "last_success_at" not in fields
    assert db.deletes == []
    assert sub["failure_count"] == 4  # the caller's row reflects the new count


@pytest.mark.parametrize("status", [401, 403, 429, 500, 502, 503])
def test_vapid_rate_limit_and_outage_statuses_never_count_against_the_subscription(push, status, capsys):
    db = FakeDb()
    push.outcome = _http_error(status, text='{"reason":"BadJwtToken"}')
    sub = _sub(failure_count=9)  # one more counted failure would delete it
    sender = _sender(db)
    for _ in range(ws.MAX_FAILURES + 2):
        assert sender.send_push(sub, PAYLOAD) is PushResult.FAILED
    assert db.updates == [] and db.deletes == []
    assert sub["failure_count"] == 9
    assert "not counted" in capsys.readouterr().out


def test_failure_counter_starts_from_zero_when_the_row_has_none(push):
    db = FakeDb()
    push.outcome = _http_error(400)
    _sender(db).send_push({"id": "s1", "endpoint": ENDPOINT, "p256dh": P256DH, "auth": AUTH}, PAYLOAD)
    assert db.updates[0][1]["failure_count"] == 1


def test_the_tenth_consecutive_failure_deletes_the_subscription(push):
    db = FakeDb()
    push.outcome = _http_error(400)
    sender = _sender(db)
    assert sender.send_push(_sub(failure_count=8), PAYLOAD) is PushResult.FAILED
    assert db.deletes == [] and db.updates[0][1]["failure_count"] == 9

    assert sender.send_push(_sub(failure_count=9), PAYLOAD) is PushResult.FAILED
    assert db.deletes == ["11111111-aaaa-bbbb-cccc-000000000001"]
    assert len(db.updates) == 1  # nothing to patch once the row is gone


def test_repeated_failures_on_one_row_reach_the_limit(push):
    db = FakeDb()
    push.outcome = _http_error(400)
    sender, sub = _sender(db), _sub()
    for _ in range(ws.MAX_FAILURES):
        sender.send_push(sub, PAYLOAD)
    assert [f["failure_count"] for _, f in db.updates] == list(range(1, ws.MAX_FAILURES))
    assert db.deletes == [sub["id"]]


def test_a_success_in_between_resets_the_counter(push):
    db = FakeDb()
    sender = _sender(db)
    push.outcome = _http_error(400)
    sender.send_push(_sub(failure_count=5), PAYLOAD)
    push.outcome = Resp(201)
    sender.send_push(_sub(failure_count=6), PAYLOAD)
    assert db.updates[-1][1]["failure_count"] == 0


@pytest.mark.parametrize("error", [
    requests.ConnectionError("secret-host unreachable /fcm/send/abc-token"),
    requests.Timeout("timed out"),
    VapidException("Missing 'sub' from claims"),
    RuntimeError("bug"),
])
def test_our_own_network_and_config_errors_never_count_against_the_subscription(push, error, capsys):
    db = FakeDb()
    push.outcome = error
    assert _sender(db).send_push(_sub(failure_count=9), PAYLOAD) is PushResult.FAILED
    assert db.updates == [] and db.deletes == []
    out = capsys.readouterr().out
    assert "not counted" in out
    assert "secret-host" not in out and "abc-token" not in out  # capability URLs stay out of the logs


@pytest.mark.parametrize("sub", [
    _sub(p256dh="AAAA"),  # wrong length: WebPushException without a response
    _sub(p256dh="not base64 !!"),  # binascii.Error
    _sub(auth=None),  # missing key
], ids=["short-p256dh", "garbage-p256dh", "missing-auth"])
def test_a_malformed_subscription_counts_as_a_failure_without_any_network_call(sub, monkeypatch):
    def no_network(*a, **k):
        raise AssertionError("must fail before any request")

    monkeypatch.setattr(requests, "post", no_network)
    db = FakeDb()
    assert _sender(db).send_push(sub, PAYLOAD) is PushResult.FAILED
    assert db.updates[0][1]["failure_count"] == 1


def test_a_disabled_sender_does_nothing(push):
    db = FakeDb()
    sender = WebPushSender(db)
    assert sender.enabled is False
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.FAILED
    assert push.calls == [] and db.updates == [] and db.deletes == []


def test_a_row_without_endpoint_is_skipped(push):
    assert _sender().send_push(_sub(endpoint=""), PAYLOAD) is PushResult.FAILED
    assert push.calls == []


def test_database_errors_never_escape(push):
    sender = _sender(FakeDb(fail=True))
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.OK
    push.outcome = _http_error(410)
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.GONE
    push.outcome = _http_error(500)
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.FAILED


def test_each_send_gets_its_own_claims_dict(push):
    sender = _sender()
    sender.send_push(_sub(), PAYLOAD)
    sender.send_push(_sub(), PAYLOAD)
    first, second = (c["vapid_claims"] for c in push.calls)
    assert first is not second  # webpush() writes aud/exp into the dict it is given


def test_the_real_library_encrypts_signs_and_sets_the_headers(monkeypatch):
    """No fake of pywebpush here: only the HTTP POST is captured, then the body is decrypted again."""
    seen = {}

    def fake_post(url, **kwargs):
        seen.update(url=url, **kwargs)
        return Resp(201)

    monkeypatch.setattr(requests, "post", fake_post)
    db = FakeDb()
    payload = {"title": "Notificaciones activas ✅", "body": "Así te llegarán tus avisos", "url": "/notificaciones", "tag": "test"}
    assert _sender(db).send_push(_sub(), payload, ttl=ws.TTL_TEST, urgency="high") is PushResult.OK

    assert seen["url"] == ENDPOINT and seen["timeout"] == ws.SEND_TIMEOUT_SECONDS
    headers = seen["headers"]
    assert headers["ttl"] == "600" and headers["urgency"] == "high"
    assert headers["content-encoding"] == "aes128gcm"
    scheme, _, params = headers["authorization"].partition(" ")
    assert scheme == "vapid" and f"k={PUBLIC}" in params
    token = params.split(",")[0][len("t="):]
    claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    assert claims["sub"] == SUBJECT and claims["aud"] == "https://fcm.googleapis.com"
    assert time.time() < claims["exp"] <= time.time() + 12 * 3600 + 5
    plain = http_ece.decrypt(seen["data"], private_key=BROWSER_KEY, auth_secret=BROWSER_AUTH, version="aes128gcm")
    assert json.loads(plain.decode("utf-8")) == payload
    assert db.updates[0][1]["failure_count"] == 0


def test_end_to_end_through_the_real_supabase_client_and_the_real_library(monkeypatch):
    """deliver_to_user -> SupabaseClient -> WebPushSender -> pywebpush, with only the HTTP layer faked."""
    import delivery
    from supabase_client import SupabaseClient

    def row(sub_id, name, failures):
        return {"id": sub_id, "endpoint": f"https://push.example/{name}", "p256dh": P256DH, "auth": AUTH,
                "failure_count": failures}

    rows = [row("s-ok", "ok", 3), row("s-gone", "gone", 0), row("s-last", "last", 9)]
    verdict = {"https://push.example/ok": 201, "https://push.example/gone": 410, "https://push.example/last": 400}
    log = []

    monkeypatch.setattr(requests, "get", lambda url, params=None, headers=None, timeout=None:
                        log.append(("GET", url, params)) or Resp(200, payload=rows))
    monkeypatch.setattr(requests, "patch", lambda url, params=None, json=None, headers=None, timeout=None:
                        log.append(("PATCH", params["id"], json)) or Resp(204))
    monkeypatch.setattr(requests, "delete", lambda url, params=None, headers=None, timeout=None:
                        log.append(("DELETE", params["id"])) or Resp(204))
    monkeypatch.setattr(requests, "post", lambda url, **kw: log.append(("POST", url)) or Resp(verdict[url]))

    client = SupabaseClient(url="https://sb.example", key="k")
    sender = WebPushSender(client, vapid=VAPID, subject=SUBJECT, lib=pywebpush)
    user = {"id": "uuuuuuuu-1111", "ntfy_topic": "utm-x", "ntfy_enabled": False}

    assert delivery.deliver_to_user(user, "T", "B", url="/", tag="t", supabase=client, sender=sender) is True

    assert log[0] == ("GET", "https://sb.example/rest/v1/moodle_push_subscriptions",
                      {"user_id": "eq.uuuuuuuu-1111", "select": "id,endpoint,p256dh,auth,failure_count,created_at,last_success_at,last_failure_at", "order": "updated_at.desc", "limit": "10"})
    assert [e[1] for e in log if e[0] == "POST"] == list(verdict)  # every subscription tried, no ntfy
    patches = [e for e in log if e[0] == "PATCH"]
    assert [(p[1], p[2]["failure_count"]) for p in patches] == [("eq.s-ok", 0)]
    assert sorted(e[1] for e in log if e[0] == "DELETE") == ["eq.s-gone", "eq.s-last"]  # 410, and the 10th failure


# ---- startup from the environment ----------------------------------------------------------------------


def _env(**over):
    env = {"VAPID_SUBJECT": SUBJECT}
    env.update(over)
    return env


def test_without_pywebpush_the_sender_is_disabled_with_one_line(monkeypatch):
    monkeypatch.setitem(sys.modules, "pywebpush", None)  # makes `import pywebpush` raise ImportError
    sender = WebPushSender.from_env(FakeDb(), env=_env(), base_dir=".")
    assert sender.enabled is False
    assert "pywebpush is not installed" in sender.status and "\n" not in sender.status
    assert sender.send_push(_sub(), PAYLOAD) is PushResult.FAILED


def test_without_a_key_the_sender_is_disabled_with_one_line(tmp_path):
    sender = WebPushSender.from_env(FakeDb(), env=_env(), base_dir=str(tmp_path))
    assert sender.enabled is False
    assert sender.status.startswith("Web Push: disabled") and "no VAPID key" in sender.status
    assert "\n" not in sender.status


def test_key_file_path_relative_to_the_project_dir(tmp_path):
    (tmp_path / "keys").mkdir()
    (tmp_path / "keys" / "v.pem").write_text(_pem(KEY), encoding="ascii")
    sender = WebPushSender.from_env(FakeDb(), env=_env(VAPID_PRIVATE_KEY_FILE="keys/v.pem"), base_dir=str(tmp_path))
    assert sender.enabled is True
    assert PUBLIC in sender.status and SUBJECT in sender.status
    assert sender.warning is None and "\n" not in sender.status


def test_default_key_file_in_the_project_dir(tmp_path):
    (tmp_path / "vapid_private.pem").write_text(_pem(KEY), encoding="ascii")
    sender = WebPushSender.from_env(FakeDb(), env=_env(), base_dir=str(tmp_path))
    assert sender.enabled is True and "vapid_private.pem" in sender.status


def test_inline_key_is_used_when_there_is_no_file(tmp_path):
    inline = _pem(KEY).strip().replace("\n", "\\n")
    sender = WebPushSender.from_env(FakeDb(), env=_env(VAPID_PRIVATE_KEY=inline), base_dir=str(tmp_path))
    assert sender.enabled is True and PUBLIC in sender.status


def test_the_key_file_wins_over_the_inline_key(tmp_path):
    other = ec.generate_private_key(ec.SECP256R1())
    (tmp_path / "v.pem").write_text(_pem(KEY), encoding="ascii")
    env = _env(VAPID_PRIVATE_KEY_FILE="v.pem", VAPID_PRIVATE_KEY=_pem(other))
    sender = WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path))
    assert PUBLIC in sender.status and _b64(_point(other)) not in sender.status


def test_a_configured_but_missing_key_file_disables_push(tmp_path):
    sender = WebPushSender.from_env(FakeDb(), env=_env(VAPID_PRIVATE_KEY_FILE="nope.pem"), base_dir=str(tmp_path))
    assert sender.enabled is False and "cannot read" in sender.status and "\n" not in sender.status


def test_a_bom_prefixed_key_file_is_accepted(tmp_path):
    (tmp_path / "v.pem").write_bytes(b"\xef\xbb\xbf" + _pem(KEY).encode("ascii"))
    sender = WebPushSender.from_env(FakeDb(), env=_env(VAPID_PRIVATE_KEY_FILE="v.pem"), base_dir=str(tmp_path))
    assert sender.enabled is True and PUBLIC in sender.status


def test_an_unreadable_key_file_disables_push_instead_of_crashing(tmp_path):
    (tmp_path / "utf16.pem").write_bytes(_pem(KEY).encode("utf-16"))  # what PowerShell's Out-File produces
    (tmp_path / "adir.pem").mkdir()
    for name in ("utf16.pem", "adir.pem"):
        sender = WebPushSender.from_env(FakeDb(), env=_env(VAPID_PRIVATE_KEY_FILE=name), base_dir=str(tmp_path))
        assert sender.enabled is False and "cannot read" in sender.status and "\n" not in sender.status


def test_an_invalid_key_disables_push_without_echoing_it(tmp_path):
    secret = "totally-secret-garbage"
    sender = WebPushSender.from_env(FakeDb(), env=_env(VAPID_PRIVATE_KEY=secret), base_dir=str(tmp_path))
    assert sender.enabled is False and "invalid VAPID key" in sender.status
    assert secret not in sender.status


def test_missing_subject_falls_back_to_localhost_with_a_warning(tmp_path):
    env = {"VAPID_PRIVATE_KEY": _pem(KEY)}
    sender = WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path))
    assert sender.enabled is True and "mailto:admin@localhost" in sender.status
    assert sender.warning and "VAPID_SUBJECT" in sender.warning


def test_a_bare_email_subject_gets_the_mailto_scheme(tmp_path):
    env = {"VAPID_PRIVATE_KEY": _pem(KEY), "VAPID_SUBJECT": "ops@example.org"}
    sender = WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path))
    assert sender.enabled is True and "subject mailto:ops@example.org" in sender.status


def test_an_invalid_subject_disables_push(tmp_path):
    env = {"VAPID_PRIVATE_KEY": _pem(KEY), "VAPID_SUBJECT": "not a contact"}
    sender = WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path))
    assert sender.enabled is False and "invalid VAPID_SUBJECT" in sender.status


def test_https_subject_is_accepted(tmp_path):
    env = {"VAPID_PRIVATE_KEY": _pem(KEY), "VAPID_SUBJECT": "https://example.org"}  # py_vapid wants a bare origin
    assert WebPushSender.from_env(FakeDb(), env=env, base_dir=str(tmp_path)).enabled is True


def test_ttl_constants_follow_the_notification_kind():
    assert ws.TTL_TASK == 24 * 3600 and ws.TTL_REMINDER == 6 * 3600 and ws.TTL_TEST == 10 * 60
    assert ws.TTL_ALERT == 24 * 3600 and ws.TTL_CLASS == 30 * 60


def test_module_level_send_push_uses_the_process_wide_sender(monkeypatch):
    class Recorder:
        def send_push(self, sub, payload, ttl, urgency):
            self.args = (sub, payload, ttl, urgency)
            return PushResult.OK

    rec = Recorder()
    monkeypatch.setattr(ws, "_default_sender", rec)
    assert ws.send_push({"endpoint": "e"}, PAYLOAD) is PushResult.OK
    assert rec.args == ({"endpoint": "e"}, PAYLOAD, ws.TTL_TASK, "normal")
