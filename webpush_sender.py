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

  VAPID_PUBLIC_KEY_EXPECTED  optional: the public key the web app was built with (Vercel's
                          NEXT_PUBLIC_VAPID_PUBLIC_KEY). When set and different from the key derived
                          from the private key, the sender is disabled: every push would be rejected.

Subscription health, kept in moodle_push_subscriptions:
  * accepted        -> last_success_at = now, failure_count = 0
  * HTTP 404 / 410  -> the browser unsubscribed: the row is deleted
  * endpoint outside ALLOWED_PUSH_HOSTS (or not https) -> treated as gone: the row is deleted
  * HTTP 429 / 5xx  -> the push service is busy or down: retried once within the same call, then
    last_failure_at (and last_failure_reason) is written; never counted against the row
  * HTTP 400 / 401 / 403 / 413 -> our payload, VAPID key, JWT or clock is wrong: logged at ERROR level,
    last_failure_at written, counted in stats ``server_errors``; never counted against the row
  * any other HTTP status and malformed subscriptions -> failure_count + 1 and last_failure_at. A row
    is deleted only once failure_count >= MAX_FAILURES AND its last success (or, never delivered, its
    creation) is older than STALE_AFTER; without either timestamp it is kept.
  * network errors on our side and unexpected exceptions say nothing about the subscription: they are
    logged but never counted against it (an outage must not wipe subscriptions).

Every outcome is counted in memory; ``WebPushSender.stats_snapshot()`` returns (and resets) them.
"""
import base64
import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Callable, Dict, Mapping, Optional, Tuple
from urllib.parse import urlparse

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_KEY_FILE = "vapid_private.pem"
FALLBACK_SUBJECT = "mailto:admin@localhost"

# Time to live in seconds: how long the push service keeps a message for an offline device.
TTL_TASK = 24 * 3600
# Status alerts ("Moodle desconectado" / "Moodle reconectado"): they stay relevant for a day.
TTL_ALERT = 24 * 3600
TTL_REMINDER = 6 * 3600
TTL_CLASS = 30 * 60
TTL_TEST = 10 * 60

MAX_PAYLOAD_BYTES = 3500  # push records hold ~4 KB once encrypted; stay well below
MAX_TITLE_CHARS = 150
MAX_URL_CHARS = 300
MAX_TAG_CHARS = 80
ELLIPSIS = "…"

MAX_FAILURES = 10  # counted consecutive failures before a stale subscription may be dropped
STALE_AFTER = timedelta(days=7)  # ...and only when its last success (or creation) is older than this
GONE_STATUSES = (404, 410)
# Our side is wrong: a malformed payload (400), a rejected VAPID JWT or key (401/403, also a skewed
# clock), an oversized payload (413). Loud, but never counted against the subscription.
SERVER_SIDE_STATUSES = (400, 401, 403, 413)
# Rate limiting (429) and push-service outages (5xx): retried once, never counted against the row.
RETRY_STATUSES = (429,)
MAX_RETRY_AFTER_SECONDS = 5.0  # a numeric Retry-After up to this is honoured...
DEFAULT_RETRY_DELAY_SECONDS = 1.5  # ...anything else (missing, longer, an HTTP date) waits this long
MAX_REASON_CHARS = 120
MAX_HINT_CHARS = 200
# Push services the browsers subscribe with; any other endpoint is dropped before a request is made
# (defense in depth against SSRF through a forged row). Mirrors the allowlist in web/lib/push.ts:
# these exact hosts plus subdomains of ALLOWED_PUSH_HOST_SUFFIXES, https only.
ALLOWED_PUSH_HOSTS = ("fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com")
ALLOWED_PUSH_HOST_SUFFIXES = (".notify.windows.com",)
# pywebpush applies NO timeout unless one is passed: a stalled push service would hang the worker.
SEND_TIMEOUT_SECONDS = 10


class PushResult(Enum):
    OK = "ok"  # accepted by the push service
    GONE = "gone"  # HTTP 404/410 or a non-allowlisted endpoint: the row was deleted
    FAILED = "failed"  # anything else; the caller treats it as "not delivered"


# ---- payload ---------------------------------------------------------------------------------------


def _clean(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    text = text.encode("utf-8", "replace").decode("utf-8")  # lone surrogates cannot be encrypted
    return text[:limit]


def _timestamp_ms(value: Any) -> int:
    """``value`` as epoch milliseconds when it is a positive number (or numeric text), else now."""
    if not isinstance(value, bool):
        try:
            number = int(float(value))
        except (TypeError, ValueError, OverflowError):
            number = 0
        if number > 0:
            return number
    return int(time.time() * 1000)


def encode_payload(payload: Mapping[str, Any], max_bytes: int = MAX_PAYLOAD_BYTES) -> str:
    """JSON for the service worker (web/public/sw.js), at most ``max_bytes`` of UTF-8.

    Keys the service worker reads (nothing else is sent):
      * ``title``, ``body``  the notification text
      * ``url``              where a tap lands (Avisos, on the notification's own entry); "/" by default
      * ``tag``              notifications with the same tag replace each other ("" = no tag)
      * ``target``           the page the notification is about (only when given)
      * ``renotify``         ``true`` to alert again when replacing a same-tag notification (only when true)
      * ``timestamp``        epoch milliseconds the notification is about; taken from the payload dict,
                             now when absent

    title/url/target/tag are clipped. When the message does not fit, ``timestamp`` is dropped first,
    then the body is cut at the longest prefix that fits and ends with an ellipsis; ``tag`` and ``url``
    are never dropped, so one message always fits a single push record.
    """
    title = _clean(payload.get("title"), MAX_TITLE_CHARS)
    url = _clean(payload.get("url") or "/", MAX_URL_CHARS)
    tag = _clean(payload.get("tag"), MAX_TAG_CHARS)
    target = _clean(payload.get("target"), MAX_URL_CHARS) if payload.get("target") else ""
    body = _clean(payload.get("body"), 4 * max_bytes)
    renotify = payload.get("renotify") is True
    timestamp = _timestamp_ms(payload.get("timestamp"))

    def dump(text_body: str, with_timestamp: bool) -> str:
        data: Dict[str, Any] = {"title": title, "body": text_body, "url": url, "tag": tag}
        if target:
            data["target"] = target
        if renotify:
            data["renotify"] = True
        if with_timestamp:
            data["timestamp"] = timestamp
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"))

    def size(text: str) -> int:
        return len(text.encode("utf-8"))

    for with_timestamp in (True, False):
        full = dump(body, with_timestamp)
        if size(full) <= max_bytes:
            return full
    low, high = 0, len(body)
    while low < high:  # size grows with the prefix length, so bisect for the longest one that fits
        mid = (low + high + 1) // 2
        if size(dump(body[:mid].rstrip() + ELLIPSIS, False)) <= max_bytes:
            low = mid
        else:
            high = mid - 1
    return dump(body[:low].rstrip() + ELLIPSIS, False)


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


_derive_public_key = public_key_b64  # the sender class has a property of the same name


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


def _host(endpoint: str) -> str:
    try:
        return urlparse(endpoint).hostname or "?"
    except ValueError:
        return "?"


def _sub_label(sub: Mapping[str, Any]) -> str:
    return f"sub {str(sub.get('id') or '?')[:8]} @ {_host(str(sub.get('endpoint') or ''))}"


def is_allowed_endpoint(endpoint: str) -> bool:
    """True for an https endpoint of a known push service (see ALLOWED_PUSH_HOSTS)."""
    try:
        parsed = urlparse(str(endpoint or ""))
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if parsed.scheme != "https" or not host:
        return False
    return host in ALLOWED_PUSH_HOSTS or any(host.endswith(s) for s in ALLOWED_PUSH_HOST_SUFFIXES)


def _is_transient(status: Optional[int]) -> bool:
    return status is not None and (status in RETRY_STATUSES or 500 <= status <= 599)


def _retry_delay(exc: BaseException) -> float:
    """Seconds to wait before the single retry: a numeric Retry-After up to 5 s, else 1.5 s."""
    headers = getattr(getattr(exc, "response", None), "headers", None) or {}
    try:
        raw = headers.get("Retry-After")
        if raw is None:
            raw = headers.get("retry-after")
        seconds = float(str(raw).strip())
    except (AttributeError, TypeError, ValueError):
        return DEFAULT_RETRY_DELAY_SECONDS
    if 0 <= seconds <= MAX_RETRY_AFTER_SECONDS:
        return seconds
    return DEFAULT_RETRY_DELAY_SECONDS


_FRACTION = re.compile(r"(\.\d+)")


def _parse_iso(value: Any) -> Optional[datetime]:
    """Lenient ISO-8601 (PostgREST timestamptz, a trailing Z, any fraction length); naive means UTC."""
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value or "").strip()
        if not text:
            return None
        text = text.replace(" ", "T", 1)
        if text[-1:] in ("Z", "z"):
            text = text[:-1] + "+00:00"
        text = _FRACTION.sub(lambda m: (m.group(1) + "000000")[:7], text, count=1)
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _http_status(exc: BaseException) -> Optional[int]:
    status = getattr(exc, "status_code", None)
    if status is None:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None) or getattr(response, "status", None)
    return status if isinstance(status, int) else None


def _response_text(exc: BaseException, limit: int, endpoint: str = "") -> str:
    """The push service's answer, on one line and clipped; the endpoint (a capability URL) is masked."""
    text = str(getattr(getattr(exc, "response", None), "text", "") or "")
    if endpoint:
        text = text.replace(endpoint, "<endpoint>")
        path = urlparse(endpoint).path
        if len(path) > 8:
            text = text.replace(path, "<endpoint>")
    return " ".join(text.split())[:limit]


def _response_hint(exc: BaseException, endpoint: str = "") -> str:
    text = _response_text(exc, MAX_REASON_CHARS, endpoint)
    return f" {text}" if text else ""


def _empty_stats() -> Dict[str, Any]:
    return {"sent_ok": 0, "failed": 0, "transient": 0, "gone": 0, "retried": 0, "server_errors": {}}


class WebPushSender:
    """Sends Web Push messages and keeps the moodle_push_subscriptions rows healthy."""

    def __init__(self, supabase=None, vapid=None, subject: str = "", lib=None,
                 status: str = "Web Push: disabled", warning: Optional[str] = None,
                 sleep: Optional[Callable[[float], None]] = None):
        self.supabase = supabase
        self.status = status  # one line for the startup log, never any key material
        self.warning = warning  # optional second startup line
        self.sleep = time.sleep if sleep is None else sleep  # injectable so tests never wait for the retry delay
        self._vapid = vapid
        self._subject = subject
        self._lib = lib  # the pywebpush module
        self._public_key: Optional[str] = None
        self._lock = threading.Lock()
        self._stats = _empty_stats()
        self._last_ok_at: Optional[str] = None
        self._last_error: Optional[str] = None
        self._last_error_at: Optional[str] = None
        self._warned_untimed = False
        # True when the latest FAILED result was not the subscription's fault (429/5xx, network, our
        # VAPID/JWT/payload rejected, sender disabled): delivery then keeps retrying that notification
        # instead of counting the attempt towards giving up on it.
        self.last_failure_server_side = False

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
        public_key = _derive_public_key(vapid)
        expected = str(env.get("VAPID_PUBLIC_KEY_EXPECTED", "") or "").strip()
        if expected and expected.rstrip("=") != public_key:
            # The web app subscribes browsers with another key: every push would be rejected (403).
            return cls(supabase, status="Web Push: disabled (VAPID public key does not match "
                                        "VAPID_PUBLIC_KEY_EXPECTED)")
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
        status = f"Web Push: enabled (key from {origin}; public key {public_key}; subject {subject})"
        return cls(supabase, vapid=vapid, subject=subject, lib=lib, status=status, warning=warning)

    @property
    def enabled(self) -> bool:
        return self._vapid is not None and self._lib is not None

    @property
    def public_key_b64(self) -> Optional[str]:
        """The VAPID public key (base64url, safe to publish), or None for a disabled sender."""
        if not self.enabled:
            return None
        if self._public_key is None:
            try:
                self._public_key = _derive_public_key(self._vapid)
            except Exception:  # noqa: BLE001 - a fake key object in tests
                return None
        return self._public_key

    # ---- stats -------------------------------------------------------------------------------------

    def stats_snapshot(self, reset: bool = True) -> Dict[str, Any]:
        """Send outcomes counted since the last reset (or since start).

        ``sent_ok``, ``failed`` and ``gone`` add up to the sends attempted. ``transient`` (429, 5xx,
        network) and ``server_errors`` ({status: count} for 400/401/403/413) break ``failed`` down;
        ``retried`` counts the single in-call retries. ``last_ok_at`` / ``last_error`` (and
        ``last_error_at``) survive a reset. Nothing here identifies a subscription or holds a secret.
        """
        with self._lock:
            snapshot = dict(self._stats)
            snapshot["server_errors"] = dict(self._stats["server_errors"])
            snapshot["last_ok_at"] = self._last_ok_at
            snapshot["last_error"] = self._last_error
            snapshot["last_error_at"] = self._last_error_at
            if reset:
                self._stats = _empty_stats()
        return snapshot

    def _count(self, key: str, error: Optional[str] = None, server_status: Optional[int] = None) -> None:
        with self._lock:
            self._stats[key] += 1
            if key == "sent_ok":
                self._last_ok_at = _now_iso()
            if server_status is not None:
                errors = self._stats["server_errors"]
                errors[server_status] = errors.get(server_status, 0) + 1
            if error:
                self._last_error = error[:MAX_REASON_CHARS]
                self._last_error_at = _now_iso()

    def _failed(self, error: str, transient: bool = False, server_status: Optional[int] = None) -> PushResult:
        self.last_failure_server_side = bool(transient or server_status is not None)
        self._count("failed", error=error, server_status=server_status)
        if transient:
            self._count("transient")
        return PushResult.FAILED

    # ---- sending -----------------------------------------------------------------------------------

    def send_push(self, sub: Dict, payload: Mapping[str, Any], ttl: int = TTL_TASK,
                  urgency: str = "normal") -> PushResult:
        """Send ``payload`` to one subscription row and update its health. Never raises.

        ``sub`` carries ``endpoint``, ``p256dh``, ``auth`` and, when known, ``id``, ``failure_count``,
        ``created_at``, ``last_success_at`` and ``last_failure_at``. A 429/5xx answer is retried once
        (see ``_retry_delay``) before the call returns.
        """
        if not self.enabled:
            self.last_failure_server_side = True
            return PushResult.FAILED
        endpoint = str(sub.get("endpoint") or "")
        if not endpoint:
            print(f"[WebPush] {_sub_label(sub)}: row without endpoint; skipped.")
            return self._failed("row without endpoint")
        if not is_allowed_endpoint(endpoint):
            print(f"[WebPush] dropping subscription with non-allowlisted host ({_sub_label(sub)}).")
            self._delete(sub)
            self._count("gone", error=f"non-allowlisted host @ {_host(endpoint)}")
            return PushResult.GONE
        label = _sub_label(sub)
        for attempt in (1, 2):
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
                status = _http_status(exc)
                if attempt == 1 and _is_transient(status):
                    delay = _retry_delay(exc)
                    print(f"[WebPush] {label}: HTTP {status}; retrying once in {delay:g} s.")
                    self._count("retried")
                    try:
                        self.sleep(delay)
                    except Exception:  # noqa: BLE001 - an interrupted wait just retries sooner
                        pass
                    continue
                return self._on_error(sub, exc)
            break
        self._patch(sub, {"last_success_at": _now_iso(), "failure_count": 0})
        self._count("sent_ok")
        return PushResult.OK

    def _failure_fields(self, reason: str) -> Dict[str, Any]:
        fields: Dict[str, Any] = {"last_failure_at": _now_iso()}
        if getattr(self.supabase, "push_failure_reason_supported", False) is True:
            fields["last_failure_reason"] = reason[:MAX_REASON_CHARS]
        return fields

    def _on_error(self, sub: Dict, exc: BaseException) -> PushResult:
        label = _sub_label(sub)
        endpoint = str(sub.get("endpoint") or "")
        host = _host(endpoint)
        status = _http_status(exc)
        if status in GONE_STATUSES:
            print(f"[WebPush] {label}: HTTP {status}, the subscription is gone; deleting it.")
            self._delete(sub)
            self._count("gone")
            return PushResult.GONE
        library_error = getattr(self._lib, "WebPushException", ())
        if status is None and not isinstance(exc, (library_error, ValueError)):
            # Network trouble on our side, a VAPID/config error or a bug: not the subscription's fault.
            print(f"[WebPush] {label}: {type(exc).__name__}; not counted against the subscription.")
            return self._failed(f"{type(exc).__name__} @ {host}", transient=True)
        if _is_transient(status):
            reason = f"HTTP {status}{_response_hint(exc, endpoint)}"
            print(f"[WebPush] {label}: {reason}; push service busy or down (retried once), not counted "
                  "against the subscription.")
            self._patch(sub, self._failure_fields(reason))
            return self._failed(f"HTTP {status} @ {host}", transient=True)
        if status in SERVER_SIDE_STATUSES:
            hint = _response_text(exc, MAX_HINT_CHARS, endpoint)
            print(f"[WebPush] ERROR status={status} host={host} hint={hint}")
            print(f"[WebPush] {label}: our payload, VAPID key, JWT or clock was rejected; not counted "
                  "against the subscription.")
            self._patch(sub, self._failure_fields(f"HTTP {status} {hint}".strip()))
            return self._failed(f"HTTP {status} @ {host}", server_status=status)
        if status is not None:
            reason = f"HTTP {status}{_response_hint(exc, endpoint)}"
        elif isinstance(exc, library_error):
            reason = " ".join(str(getattr(exc, "message", exc)).split())[:MAX_REASON_CHARS]
        else:
            reason = type(exc).__name__
        failures = int(sub.get("failure_count") or 0) + 1
        if failures >= MAX_FAILURES and self._is_stale(sub):
            print(f"[WebPush] {label}: {reason}; {failures} consecutive failures and no success for over "
                  f"{STALE_AFTER.days} days, deleting the subscription.")
            self._delete(sub)
        else:
            kept = " (kept: delivered recently or age unknown)" if failures >= MAX_FAILURES else ""
            print(f"[WebPush] {label}: {reason} (failure {failures}/{MAX_FAILURES}){kept}")
            sub["failure_count"] = failures
            self._patch(sub, {"failure_count": failures, **self._failure_fields(reason)})
        error = f"HTTP {status} @ {host}" if status is not None else f"{type(exc).__name__} @ {host}"
        return self._failed(error)

    def _is_stale(self, sub: Mapping[str, Any]) -> bool:
        """True when the row's last success (else its creation) is older than STALE_AFTER."""
        since = _parse_iso(sub.get("last_success_at")) or _parse_iso(sub.get("created_at"))
        if since is None:
            if not self._warned_untimed:
                self._warned_untimed = True
                print("[WebPush] subscriptions carry no last_success_at/created_at; counted failures will "
                      "not delete them.")
            return False
        return datetime.now(timezone.utc) - since > STALE_AFTER

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
