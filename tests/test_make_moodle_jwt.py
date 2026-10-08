import base64
import hashlib
import hmac
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import make_moodle_jwt as mj  # noqa: E402

SECRET = "s" * 40


def _decode(part):
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def test_token_signature_verifies_and_claims_are_correct():
    token = mj.make_token(SECRET, years=5, now=1_000_000)
    head, body, sig = token.split(".")
    expected = hmac.new(SECRET.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    assert sig == base64.urlsafe_b64encode(expected).rstrip(b"=").decode()
    assert _decode(head) == {"alg": "HS256", "typ": "JWT"}
    claims = _decode(body)
    assert claims == {"role": "moodle_app", "iss": "supabase", "iat": 1_000_000, "exp": 1_000_000 + 5 * 365 * 86400}


def test_main_prints_only_token(monkeypatch, capsys):
    monkeypatch.setenv("JWT_SECRET", SECRET)
    assert mj.main([]) == 0
    out = capsys.readouterr().out.strip()
    assert len(out.split(".")) == 3


def test_missing_or_short_secret_fails(monkeypatch, capsys):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    assert mj.main([]) == 2
    monkeypatch.setenv("JWT_SECRET", "short")
    assert mj.main([]) == 2
    assert capsys.readouterr().out == ""


def test_custom_secret_env(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    monkeypatch.setenv("MY_SECRET", SECRET)
    assert mj.main(["--secret-env", "MY_SECRET", "--years", "1"]) == 0
