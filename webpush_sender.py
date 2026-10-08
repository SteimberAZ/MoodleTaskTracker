"""Native Web Push (VAPID) sender for the installed PWA (iOS 16.4+ home-screen app, Android, desktop).

The worker is the only process that sends pushes. The VAPID *private* key lives only on the VPS; the
web app gets the matching *public* key (NEXT_PUBLIC_VAPID_PUBLIC_KEY, printed by
scripts/generate_vapid.py) and merely stores each browser's subscription in moodle_push_subscriptions.

Environment (``.env`` is loaded by supabase_client):
  VAPID_PRIVATE_KEY_FILE  path of the PEM written by scripts/generate_vapid.py; relative paths are
                          resolved against the project directory. Checked first.
  VAPID_PRIVATE_KEY       the key itself: PEM text (a literal ``\\n`` is accepted), base64url DER or a
                          base64url raw 32-byte scalar. Used when no key file is configured.
  (default file)          ./vapid_private.pem in the project directory.
  VAPID_SUBJECT           mailto:/https: contact for the push services. Falls back to
                          mailto:admin@localhost with a warning; some services may reject that.

Without pywebpush or without a key the sender is disabled (a single status line for the startup log)
and the worker keeps delivering through ntfy. Nothing here raises into the worker loop.

Subscription health, kept in moodle_push_subscriptions:
  * accepted        -> last_success_at = now, failure_count = 0
  * HTTP 404 / 410  -> the browser unsubscribed: the row is deleted
  * other HTTP errors and malformed subscriptions -> failure_count + 1 and last_failure_at;
    the 10th consecutive failure deletes the row
  * network errors on our side, VAPID/config errors and unexpected exceptions say nothing about the
    subscription: they are logged but never counted against it (an outage must not wipe subscriptions).
"""
import base64
import json
import os
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Mapping, Optional, Tuple
from urllib.parse import urlparse

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_KEY_FILE = "vapid_private.pem"
FALLBACK_SUBJECT = "mailto:admin@localhost"

# Time to live in seconds: how long the push service keeps a message for an offline device.
TTL_TASK = 24 * 3600
TTL_ALERT = 24 * 3600
TTL_REMINDER = 6 * 3600
TTL_CLASS = 30 * 60
TTL_TEST = 10 * 60

MAX_PAYLOAD_BYTES = 3500  # push records hold ~4 KB once encrypted; stay well below
MAX_TITLE_CHARS = 150
MAX_URL_CHARS = 300
MAX_TAG_CHARS = 80
ELLIPSIS = "…"

MAX_FAILURES = 10  # consecutive failed sends before a subscription is dropped
GONE_STATUSES = (404, 410)
# pywebpush applies NO timeout unless one is passed: a stalled push service would hang the worker.
SEND_TIMEOUT_SECONDS = 10


class PushResult(Enum):
    OK = "ok"  # accepted by the push service
    GONE = "gone"  # HTTP 404/410: the subscription no longer exists and its row was deleted
    FAILED = "failed"  # anything else; the caller treats it as "not delivered"


# ---- payload ---------------------------------------------------------------------------------------


def _clean(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    text = text.encode("utf-8", "replace").decode("utf-8")  # lone surrogates cannot be encrypted
    return text[:limit]


def encode_payload(payload: Mapping[str, Any], max_bytes: int = MAX_PAYLOAD_BYTES) -> str:
    """JSON ``{"title", "body", "url", "tag"}`` (plus ``target`` when given) for the service worker, at most ``max_bytes`` of UTF-8.

    Only those keys are sent. ``url`` is where a tap lands (Avisos, on the notification's own entry);
    ``target`` is the page the notification is about. title/url/target/tag are clipped; an oversized
    body is cut at the longest prefix that fits and ends with an ellipsis, so one message always fits
    a single push record.
    """
    title = _clean(payload.get("title"), MAX_TITLE_CHARS)
    url = _clean(payload.get("url") or "/", MAX_URL_CHARS)
    tag = _clean(payload.get("tag"), MAX_TAG_CHARS)
    target = _clean(payload.get("target"), MAX_URL_CHARS) if payload.get("target") else ""
    body = _clean(payload.get("body"), 4 * max_bytes)

    def dump(text_body: str) -> str:
        data = {"title": title, "body": text_body, "url": url, "tag": tag}
        if target:
            data["target"] = target
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"))

    def size(text: str) -> int:
        return len(text.encode("utf-8"))

    full = dump(body)
    if size(full) <= max_bytes:
        return full
    low, high = 0, len(body)
    while low < high:  # size grows with the prefix length, so bisect for the longest one that fits
        mid = (low + high + 1) // 2
        if size(dump(body[:mid].rstrip() + ELLIPSIS)) <= max_bytes:
            low = mid
        else:
            high = mid - 1
    return dump(body[:low].rstrip() + ELLIPSIS)


# ---- VAPID key -------------------------------------------------------------------------------------


def load_vapid(text: str):
    """py_vapid ``Vapid`` from PEM text, base64url DER (PKCS8 or SEC1) or a base64url raw 32-byte scalar.

    PEMs go through ``cryptography`` directly: ``Vapid.from_pem`` chokes on a trailing blank line.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from py_vapid import Vapid

    value = str(text or "").strip().replace("\\n", "\n")  # .env files often hold a PEM on one line
    if not value:
        raise ValueError("empty VAPID private key")
    if "-----BEGIN" in value:
        vapid = Vapid(serialization.load_pem_private_key(value.encode("ascii"), password=None))
    else:
        vapid = Vapid.from_string(value)
    key = vapid.private_key
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("the VAPID key must be a P-256 (prime256v1) EC key")
    return vapid


def public_key_b64(vapid) -> str:
    """The public key as the browser expects it: base64url of the 65-byte uncompressed point (87 chars)."""
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    raw = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def read_key_source(env: Mapping[str, str], base_dir: str) -> Tuple[Optional[str], str]:
    """Key text and where it came from, or ``(None, reason)`` when no usable source is configured."""

    def read(path: str, label: str) -> Tuple[Optional[str], str]:
        try:
            with open(path, "r", encoding="utf-8-sig") as fh:  # tolerate the BOM some Windows editors add
                return fh.read(), label
        except (OSError, ValueError) as exc:  # ValueError: not text (e.g. a UTF-16 file)
            return None, f"cannot read {label} ({type(exc).__name__})"

    key_file = str(env.get("VAPID_PRIVATE_KEY_FILE", "") or "").strip()
    if key_file:
        path = os.path.expanduser(key_file)
        path = path if os.path.isabs(path) else os.path.join(base_dir, path)
        return read(path, f"VAPID_PRIVATE_KEY_FILE ({os.path.basename(path)})")
    inline = str(env.get("VAPID_PRIVATE_KEY", "") or "").strip()
    if inline:
        return inline, "VAPID_PRIVATE_KEY"
    default_path = os.path.join(base_dir, DEFAULT_KEY_FILE)
    if os.path.isfile(default_path):
        return read(default_path, DEFAULT_KEY_FILE)
    return None, f"no VAPID key found; run scripts/generate_vapid.py or set VAPID_PRIVATE_KEY_FILE ({DEFAULT_KEY_FILE} by default)"


def resolve_subject(env: Mapping[str, str]) -> Tuple[str, bool]:
    """The VAPID ``sub`` claim and whether the localhost fallback had to be used."""
    raw = str(env.get("VAPID_SUBJECT", "") or "").strip()
    if not raw:
        return FALLBACK_SUBJECT, True
    if "@" in raw and not raw.lower().startswith(("mailto:", "https:", "http:")):
        raw = "mailto:" + raw
    return raw, False


# ---- sender ----------------------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sub_label(sub: Mapping[str, Any]) -> str:
    host = urlparse(str(sub.get("endpoint") or "")).netloc or "?"
    return f"sub {str(sub.get('id') or '?')[:8]} @ {host}"


def _http_status(exc: BaseException) -> Optional[int]:
    status = getattr(exc, "status_code", None)
    if status is None:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None) or getattr(response, "status", None)
    return status if isinstance(status, int) else None


def _response_hint(exc: BaseException) -> str:
    text = str(getattr(getattr(exc, "response", None), "text", "") or "")
    text = " ".join(text.split())[:120]
    return f" {text}" if text else ""


class WebPushSender:
    """Sends Web Push messages and keeps the moodle_push_subscriptions rows healthy."""

    def __init__(self, supabase=None, vapid=None, subject: str = "", lib=None,
                 status: str = "Web Push: disabled", warning: Optional[str] = None):
        self.supabase = supabase
        self.status = status  # one line for the startup log
        self.warning = warning  # optional second startup line
        self._vapid = vapid
        self._subject = subject
        self._lib = lib  # the pywebpush module

    @classmethod
    def from_env(cls, supabase=None, env: Optional[Mapping[str, str]] = None,
                 base_dir: Optional[str] = None) -> "WebPushSender":
        """Build the sender from the environment; a missing library or key yields a disabled one."""
        env = os.environ if env is None else env
        base_dir = base_dir or PROJECT_DIR
        try:
            import pywebpush as lib
        except ImportError:
            return cls(supabase, status="Web Push: disabled (pywebpush is not installed; "
                                        "run pip install -r requirements-worker.txt)")
        key_text, origin = read_key_source(env, base_dir)
        if key_text is None:
            return cls(supabase, status=f"Web Push: disabled ({origin})")
        try:
            vapid = load_vapid(key_text)
        except Exception as exc:  # noqa: BLE001 - never echo key material, only the error type
            return cls(supabase, status=f"Web Push: disabled (invalid VAPID key from {origin}: {type(exc).__name__})")
        subject, used_fallback = resolve_subject(env)
        try:  # signing a throwaway claim set validates the subject before the first real send
            vapid.sign({"sub": subject, "aud": "https://push.invalid", "exp": int(time.time()) + 60})
        except Exception:  # noqa: BLE001
            return cls(supabase, status=f"Web Push: disabled (invalid VAPID_SUBJECT {subject!r}; "
                                        "use mailto:you@example.com or https://...)")
        warning = None
        if used_fallback:
            warning = (f"Web Push: VAPID_SUBJECT is not set, using {FALLBACK_SUBJECT} (some push services "
                       "may reject it); set VAPID_SUBJECT=mailto:<your real email>")
        status = f"Web Push: enabled (key from {origin}; public key {public_key_b64(vapid)}; subject {subject})"
        return cls(supabase, vapid=vapid, subject=subject, lib=lib, status=status, warning=warning)

    @property
    def enabled(self) -> bool:
        return self._vapid is not None and self._lib is not None

    def send_push(self, sub: Dict, payload: Mapping[str, Any], ttl: int = TTL_TASK,
                  urgency: str = "normal") -> PushResult:
        """Send ``payload`` to one subscription row and update its health. Never raises.

        ``sub`` carries ``endpoint``, ``p256dh``, ``auth`` and, when known, ``id`` and ``failure_count``.
        """
        if not self.enabled:
            return PushResult.FAILED
        endpoint = str(sub.get("endpoint") or "")
        if not endpoint:
            print(f"[WebPush] {_sub_label(sub)}: row without endpoint; skipped.")
            return PushResult.FAILED
        try:
            data = encode_payload(payload)
            info = {"endpoint": endpoint, "keys": {"p256dh": sub.get("p256dh"), "auth": sub.get("auth")}}
            self._lib.webpush(
                subscription_info=info,
                data=data,
                vapid_private_key=self._vapid,
                vapid_claims={"sub": self._subject},  # a fresh dict: webpush() writes aud/exp into it
                ttl=int(ttl),
                headers={"Urgency": urgency},
                timeout=SEND_TIMEOUT_SECONDS,
            )
        except Exception as exc:  # noqa: BLE001 - classified below
            return self._on_error(sub, exc)
        self._patch(sub, {"last_success_at": _now_iso(), "failure_count": 0})
        return PushResult.OK

    def _on_error(self, sub: Dict, exc: BaseException) -> PushResult:
        label = _sub_label(sub)
        status = _http_status(exc)
        if status in GONE_STATUSES:
            print(f"[WebPush] {label}: HTTP {status}, the subscription is gone; deleting it.")
            self._delete(sub)
            return PushResult.GONE
        library_error = getattr(self._lib, "WebPushException", ())
        if status is None and not isinstance(exc, (library_error, ValueError)):
            # Network trouble on our side, a VAPID/config error or a bug: not the subscription's fault.
            print(f"[WebPush] {label}: {type(exc).__name__}; not counted against the subscription.")
            return PushResult.FAILED
        if status is not None:
            reason = f"HTTP {status}{_response_hint(exc)}"
        elif isinstance(exc, library_error):
            reason = " ".join(str(getattr(exc, "message", exc)).split())[:120]
        else:
            reason = type(exc).__name__
        failures = int(sub.get("failure_count") or 0) + 1
        if failures >= MAX_FAILURES:
            print(f"[WebPush] {label}: {reason}; {failures} consecutive failures, deleting the subscription.")
            self._delete(sub)
        else:
            print(f"[WebPush] {label}: {reason} (failure {failures}/{MAX_FAILURES})")
            sub["failure_count"] = failures
            self._patch(sub, {"failure_count": failures, "last_failure_at": _now_iso()})
        return PushResult.FAILED

    def _patch(self, sub: Mapping[str, Any], fields: Dict) -> None:
        if self.supabase is not None and sub.get("id"):
            try:
                self.supabase.update_push_subscription(sub["id"], fields)
            except Exception as exc:  # noqa: BLE001
                print(f"[WebPush] could not update {_sub_label(sub)}: {type(exc).__name__}")

    def _delete(self, sub: Mapping[str, Any]) -> None:
        if self.supabase is not None and sub.get("id"):
            try:
                self.supabase.delete_push_subscription(sub["id"])
            except Exception as exc:  # noqa: BLE001
                print(f"[WebPush] could not delete {_sub_label(sub)}: {type(exc).__name__}")


_default_sender: Optional[WebPushSender] = None


def default_sender() -> WebPushSender:
    """Process-wide sender built from the environment on first use (scripts and the REPL)."""
    global _default_sender
    if _default_sender is None:
        from supabase_client import SupabaseClient

        _default_sender = WebPushSender.from_env(SupabaseClient.for_worker())
        print(f"[WebPush] {_default_sender.status}")
    return _default_sender


def send_push(sub: Dict, payload: Mapping[str, Any], ttl: int = TTL_TASK, urgency: str = "normal") -> PushResult:
    """Send one message through the process-wide sender; see ``WebPushSender.send_push``."""
    return default_sender().send_push(sub, payload, ttl, urgency)
