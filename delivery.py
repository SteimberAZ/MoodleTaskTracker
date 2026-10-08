"""One delivery path for every user-facing notification of the worker.

``deliver_to_user`` sends a notification through *all* channels of one user: native Web Push to each
of their installed-PWA subscriptions (the primary channel) and ntfy to their private topic (optional,
switched per user with ``moodle_users.ntfy_enabled``; a missing value means off). Task milestones,
custom reminders, class reminders and "Moodle desconectado" alerts all go through it. The "Enviar
prueba" button (``process_push_tests``) targets one subscription, so it uses the same sender directly.
Every attempt that matters is handed to ``history`` (notification_log.NotificationLog) with its
``kind``, per-channel outcome and ``push_state``, so the web can list it; that never affects the
delivery result.

Success rule (honest delivery): a notification counts as delivered only when it really reached the
user, i.e. at least one Web Push subscription accepted it, or ntfy accepted it AND the user confirmed
their ntfy topic (``moodle_users.ntfy_confirmed_at``). An unconfirmed ntfy copy is still sent, best
effort, but never counts, and "push off" (no sender / sender disabled) is never success. A partial
push (some devices accepted, others failed) counts as delivered; the failing devices are not retried
for that notification. Callers use the result to decide whether to record a milestone / advance a
reminder.

Bounded retries: failures are tracked in memory per (user id, kind, retry key = tag by default). After
a failed attempt the key waits ``BACKOFF_MINUTES`` (1, 5, 15, 60, 60 ...) before it may be tried again;
calls inside that wait return False at once without sending or recording anything. ntfy is sent at
most once per failure streak. The history gets one row for the first failure of a streak, one for the
eventual success and one more when the streak reaches ``MAX_ATTEMPTS`` (``is_exhausted`` then tells the
caller to give up on it), never one per tick. A user without any usable channel (no devices and no
ntfy) gets at most one "failed" row per key and calendar day. State older than 24 hours is pruned.
"""
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional, Set, Tuple

import notifier
from webpush_sender import TTL_TASK, TTL_TEST, PushResult

HIGH_PRIORITIES = frozenset({"urgent", "max", "high", "4", "5"})

NOTIFICATIONS_PATH = "/notificaciones"

TEST_PAYLOAD = {
    "title": "Notificaciones activas ✅",
    "body": "Así te llegarán tus avisos de Moodle",
    "url": NOTIFICATIONS_PATH,
    "tag": "test",
}

# push_total recorded in the history when the user's subscriptions could not be read: the devices
# were never tried, which is not the same as having none (push_total 0).
PUSH_UNKNOWN = -1

# Bounded retries (see the module docstring).
MAX_ATTEMPTS = 6
BACKOFF_MINUTES = (1, 5, 15, 60, 60)
STATE_MAX_AGE_SECONDS = 24 * 3600
_DAY_TZ = timezone(timedelta(hours=-5))  # calendar day of the "no usable channel" row (Ecuador, no DST)

_last_logged: Dict[str, str] = {}
# (user id, kind, retry key) -> {attempts, next_attempt_at, ntfy_sent, first_failure_logged, day, updated_at}
_ATTEMPTS: Dict[Tuple[str, str, str], Dict[str, Any]] = {}


def _now() -> float:
    """Current epoch seconds (tests replace it)."""
    return time.time()


def new_log_id() -> str:
    """Id of one history row, generated before the notification is sent so the push can point at it."""
    return str(uuid.uuid4())


def history_url(log_id: Optional[str]) -> str:
    """Where tapping a notification lands: its own entry in Avisos, or just Avisos without a history row."""
    return f"{NOTIFICATIONS_PATH}?n={log_id}" if log_id else NOTIFICATIONS_PATH


def web_app_url() -> str:
    """Public base URL of the web app (env WEB_APP_URL, no trailing slash); empty when not configured."""
    return os.environ.get("WEB_APP_URL", "").strip().rstrip("/")


def absolute_web_url(path: str) -> str:
    """``path`` on the configured web app, or "" when WEB_APP_URL is unset (ntfy then keeps its old behaviour)."""
    base = web_app_url()
    return f"{base}{path}" if base else ""


def _log_changed(key: str, message: Optional[str]) -> None:
    """Print ``message`` only when it differs from the last one for ``key`` (None = healthy again).

    Keeps a broken table or an outage from writing one log line per worker tick.
    """
    if message is None:
        _last_logged.pop(key, None)
    elif _last_logged.get(key) != message:
        _last_logged[key] = message
        print(message)


def urgency_for(priority: Any) -> str:
    """Web Push ``Urgency`` header for an ntfy-style priority (urgent/high -> high, otherwise normal)."""
    return "high" if str(priority or "").strip().lower() in HIGH_PRIORITIES else "normal"


def ntfy_enabled(user: Dict) -> bool:
    """ntfy is on only when the user row says so; a missing column / value means off."""
    return user.get("ntfy_enabled") is True


def ntfy_confirmed(user: Dict) -> bool:
    """True when the user confirmed their ntfy topic (``ntfy_confirmed_at`` set): only then ntfy counts."""
    return bool(user.get("ntfy_confirmed_at"))


def history_active(history, user_id: str, kind: Optional[str]) -> bool:
    """True when this attempt will be recorded: a usable history, a kind and a user id."""
    return history is not None and bool(kind) and bool(user_id) and getattr(history, "enabled", True) is not False


def _record_history(history, user_id: str, kind: Optional[str], title, body, url, tag, log_id=None, **outcome) -> None:
    """Hand one outcome to the history; never raises. Skipped without a history, a kind or a user id.

    ``kind`` is chosen by each caller (task / reminder / class / status / test), never inferred from
    the tag. A send without a user id (legacy env-topic path) is not recorded. ``log_id`` is the id
    the notification was sent with, so its push link finds this row.
    """
    if history is None or not kind or not user_id:
        return
    try:
        history.record(user_id, kind, title, body, url, tag, log_id=log_id, **outcome)
        _log_changed("history-record", None)
    except Exception as exc:  # noqa: BLE001 - logging must never break a delivery
        _log_changed("history-record", f"[Deliver] could not record the notification history: {type(exc).__name__}")


# ---- bounded retry state ------------------------------------------------------------------------------


def _state_key(user_id: Any, kind: Any, tag: Any) -> Tuple[str, str, str]:
    return (str(user_id or ""), str(kind or ""), str(tag or ""))


def _backoff_seconds(attempts: int) -> int:
    """Wait after the ``attempts``-th failed attempt in a row (the last step repeats)."""
    return BACKOFF_MINUTES[min(max(attempts, 1), len(BACKOFF_MINUTES)) - 1] * 60


def _calendar_day(ts: float) -> str:
    return datetime.fromtimestamp(ts, _DAY_TZ).strftime("%Y-%m-%d")


def _prune_state(now: float) -> None:
    for key, state in list(_ATTEMPTS.items()):
        if now - float(state.get("updated_at", 0)) > STATE_MAX_AGE_SECONDS:
            _ATTEMPTS.pop(key, None)
            # Their "waiting" / "no channel" log markers would otherwise stay forever (e.g. a class tag).
            _last_logged.pop(f"backoff {key}", None)
            _last_logged.pop(f"nochannel {key}", None)


def is_exhausted(user_id: Any, kind: Any, tag: Any) -> bool:
    """True when the key (user id, kind, retry key / tag) failed ``MAX_ATTEMPTS`` times in a row.

    Callers then give up on that notification (record the milestone, advance the reminder) so it is
    not retried forever; the history already holds its "failed" rows.
    """
    state = _ATTEMPTS.get(_state_key(user_id, kind, tag))
    return bool(state) and int(state.get("attempts", 0)) >= MAX_ATTEMPTS


def pending_attempts(user_id: Any, kind: Any, tag: Any) -> int:
    """Failed attempts of the current streak of one key (0 when it has none)."""
    state = _ATTEMPTS.get(_state_key(user_id, kind, tag))
    return int(state.get("attempts", 0)) if state else 0


def forget(user_id: Any, kind: Any, tag: Any) -> None:
    """Drop the retry state of one key (a caller gave up on it, so a later notification starts fresh)."""
    _ATTEMPTS.pop(_state_key(user_id, kind, tag), None)


def reset_delivery_state() -> None:
    """Forget every retry streak and logged message (tests)."""
    _ATTEMPTS.clear()
    _last_logged.clear()


def _failed_attempt(key, state: Optional[Dict[str, Any]], now: float, ntfy_sent: bool) -> Dict[str, Any]:
    """Count one failed attempt for ``key`` and schedule the next one."""
    state = state or {"attempts": 0, "ntfy_sent": False, "first_failure_logged": False, "day": None}
    state["attempts"] = int(state.get("attempts", 0)) + 1
    state["next_attempt_at"] = now + _backoff_seconds(state["attempts"])
    state["updated_at"] = now
    state["ntfy_sent"] = bool(state.get("ntfy_sent")) or ntfy_sent
    _ATTEMPTS[key] = state
    return state


def deliver_to_user(
    user: Dict,
    title: str,
    body: str,
    url: str = "/",
    tag: str = "moodle",
    priority: str = "default",
    *,
    ttl: int = TTL_TASK,
    ntfy_tags: str = "bell",
    ntfy_link: str = "",
    kind: Optional[str] = None,
    history=None,
    supabase=None,
    sender=None,
    ntfy: Optional[Callable[..., bool]] = None,
    renotify: bool = False,
    retry_key: Optional[str] = None,
) -> bool:
    """Send one notification to every channel of ``user``; True only when it really reached them.

    ``user`` needs ``id`` (Web Push subscriptions), ``ntfy_topic``, ``ntfy_enabled`` and optionally
    ``ntfy_confirmed_at``. ``url`` is the page the notification is about (a path inside the PWA);
    ``tag`` replaces an older notification with the same tag, and ``renotify`` asks the device to alert
    again when it does. ``priority`` uses ntfy words and also picks the Web Push urgency. ``ntfy_tags`` /
    ``ntfy_link`` only shape the ntfy copy. A user without a topic is never routed to the owner's
    topic. ``kind`` (task / reminder / class / status / test) and ``history`` record this attempt in the
    user's notification history; without either nothing is recorded. ``retry_key`` (default: ``tag``)
    names the notification for the bounded retries, e.g. one per task milestone although they share
    the tag. Never raises. See the module docstring for the success rule and the retry policy.

    Tapping a notification opens its own entry in Avisos: the history row id is generated here, before
    sending, and the push payload carries ``url=/notificaciones?n=<id>`` plus the original page as
    ``target`` (the row keeps it in its ``url`` column, so Avisos can offer an "Abrir" button). When
    nothing is recorded the payload links to plain ``/notificaciones``. With ``WEB_APP_URL`` set the
    ntfy copy gets the same link as its click action.
    """
    user_id = str(user.get("id") or "")
    label = user_id[:8] or "?"
    now = _now()
    _prune_state(now)
    key = _state_key(user_id, kind, retry_key or tag)
    state = _ATTEMPTS.get(key) if user_id else None
    wait_key = f"backoff {key}"
    if state is not None and now < float(state.get("next_attempt_at", 0)):
        _log_changed(
            wait_key,
            f"[Deliver] user {label}: {kind or 'notification'} {key[2]} failed {state['attempts']}x; "
            f"waiting before retrying (max {MAX_ATTEMPTS}).",
        )
        return False
    _log_changed(wait_key, None)

    log_id = new_log_id() if history_active(history, user_id, kind) else None
    link = history_url(log_id)
    parts = []
    push_ok = push_total = 0
    ntfy_attempted = ntfy_ok = False
    topic = str(user.get("ntfy_topic") or "").strip()
    ntfy_on = ntfy_enabled(user) and bool(topic)

    # 1. Web Push (primary): every subscription the user registered from an installed PWA / browser.
    subs = []
    if sender is not None and getattr(sender, "enabled", False) and supabase is not None and user_id:
        try:
            subs = supabase.fetch_push_subscriptions(user_id) or []
            push_state = "no_devices" if not subs else None
            _log_changed(f"subs {user_id}", None)
        except Exception as exc:  # noqa: BLE001 - ntfy must still go out
            _log_changed(f"subs {user_id}", f"[Deliver] user {label}: could not read push subscriptions: {exc}")
            subs, push_state = [], "read_error"
    else:
        push_state = "disabled"

    # No usable channel at all: nothing to send. One "failed" row per key and day, never one per tick.
    if push_state in ("disabled", "no_devices") and not ntfy_on:
        if user_id:
            state = _failed_attempt(key, state, now, ntfy_sent=False)
            day = _calendar_day(now)
            if state.get("day") != day:
                state["day"] = day
                _record_history(
                    history, user_id, kind, title, body, url, tag, log_id,
                    push_ok=0, push_total=0, ntfy_attempted=False, ntfy_ok=False,
                    push_state=push_state, delivered=False,
                )
        _log_changed(
            f"nochannel {key}",
            f"[Deliver] user {label}: no usable channel ({'push ' + push_state}, ntfy off) -> NOT delivered",
        )
        return False
    _log_changed(f"nochannel {key}", None)

    if push_state == "disabled":
        parts.append("push off")
    else:
        payload = {"title": title, "body": body, "url": link, "target": url, "tag": tag}
        if renotify:
            payload["renotify"] = True
        counts = {PushResult.OK: 0, PushResult.GONE: 0, PushResult.FAILED: 0}
        for sub in subs:
            try:
                result = sender.send_push(sub, payload, ttl, urgency_for(priority))
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] user {label}: push send crashed: {type(exc).__name__}")
                result = PushResult.FAILED
            counts[result if result in counts else PushResult.FAILED] += 1
        # A GONE device was deleted during this call: it is no longer one of the user's devices, so it
        # neither makes a delivery "partial" nor counts in push_total.
        push_ok, push_total = counts[PushResult.OK], len(subs) - counts[PushResult.GONE]
        if push_state is None:
            if push_total <= 0:
                push_state = "no_devices"
            else:
                push_state = "ok" if push_ok == push_total else ("partial" if push_ok else "failed")
        text = f"push {push_ok}/{push_total} ok" if subs else "push none"
        if push_state == "read_error":
            push_total, text = PUSH_UNKNOWN, "push FAILED (subscriptions unreadable)"
        parts.append(text + (f" ({counts[PushResult.GONE]} gone)" if counts[PushResult.GONE] else ""))

    # 2. ntfy (optional, per user). Sent at most once per failure streak of this key.
    if ntfy_on and state is not None and state.get("ntfy_sent"):
        parts.append("ntfy already sent")
    elif ntfy_on:
        ntfy_attempted = True
        post = ntfy or notifier.post_ntfy
        text = f"{body}\n🔗 {ntfy_link}" if ntfy_link else body
        click = absolute_web_url(link)
        extra = {"click": click} if click else {}  # only passed when configured: custom senders stay compatible
        try:
            ntfy_ok = bool(post(title, text, priority=priority, tags=ntfy_tags, topic=topic, **extra))
        except Exception as exc:  # noqa: BLE001
            print(f"[Deliver] user {label}: ntfy crashed: {type(exc).__name__}")
            ntfy_ok = False
        if ntfy_ok:
            parts.append("ntfy ok" if ntfy_confirmed(user) else "ntfy ok (unconfirmed, does not count)")
        else:
            parts.append("ntfy failed")
    else:
        parts.append("ntfy off")

    delivered = push_ok > 0 or (ntfy_ok and ntfy_confirmed(user))
    outcome = dict(
        push_ok=push_ok, push_total=push_total, ntfy_attempted=ntfy_attempted, ntfy_ok=ntfy_ok,
        push_state=push_state, delivered=delivered,
    )
    if delivered or not user_id:
        if user_id:
            _ATTEMPTS.pop(key, None)
        print(f"[Deliver] user {label}: {', '.join(parts)} -> {'delivered' if delivered else 'NOT delivered'}")
        _record_history(history, user_id, kind, title, body, url, tag, log_id, **outcome)
        return delivered

    state = _failed_attempt(key, state, now, ntfy_sent=ntfy_ok)
    attempts = state["attempts"]
    if not state.get("first_failure_logged") or attempts == MAX_ATTEMPTS:
        state["first_failure_logged"] = True
        _record_history(history, user_id, kind, title, body, url, tag, log_id, **outcome)
    retry = (
        f"giving up after {attempts} attempts" if attempts >= MAX_ATTEMPTS
        else f"attempt {attempts}/{MAX_ATTEMPTS}, retry in {_backoff_seconds(attempts) // 60} min"
    )
    print(f"[Deliver] user {label}: {', '.join(parts)} -> NOT delivered ({retry})")
    return False


# (subscription id, test_requested_at) of tests already sent whose flag could not be cleared yet.
_ANSWERED_TESTS: Set[Tuple[str, str]] = set()


def _clear_test_flag(supabase, row: Dict) -> bool:
    try:
        return bool(supabase.clear_push_test_request(row["id"], row.get("test_requested_at")))
    except Exception as exc:  # noqa: BLE001
        print(f"[Deliver] could not clear the push test flag: {type(exc).__name__}")
        return False


def process_push_tests(supabase, sender, history=None, answered: Optional[Set[Tuple[str, str]]] = None) -> int:
    """Answer the "Enviar prueba" button: send a test push to every subscription that asked for one.

    The web sets ``test_requested_at`` on the row; this clears it again, also when the send failed or
    raised, so a broken subscription cannot loop. The clear only matches the value that was read, so a
    newer press made meanwhile survives and gets its own test. A request whose clear failed is kept in
    ``answered`` (process-wide by default) and is never sent twice: later ticks only retry the clear.
    Returns how many tests were accepted. Never raises for a single row, and does nothing without a
    database. Each test is recorded in ``history`` as kind "test" (one device, so push 1/1 or 0/1, with
    push_state ok / failed). With the sender disabled the request is still answered: its flag is
    cleared and a "failed" row with push_state "disabled" tells the user why nothing arrived.
    """
    if supabase is None or not getattr(supabase, "is_configured", False):
        return 0
    sender_on = sender is not None and getattr(sender, "enabled", False)
    try:
        rows = supabase.fetch_push_test_requests()
        _log_changed("push-tests", None)
    except Exception as exc:  # noqa: BLE001
        _log_changed("push-tests", f"[Deliver] could not read push test requests: {exc}")
        return 0
    answered = _ANSWERED_TESTS if answered is None else answered
    keys = {(str(row.get("id")), str(row.get("test_requested_at") or "")) for row in rows}
    answered &= keys  # requests that are gone from the table need no more tracking
    sent = 0
    for row in rows:
        key = (str(row.get("id")), str(row.get("test_requested_at") or ""))
        if key in answered:
            if _clear_test_flag(supabase, row):
                answered.discard(key)
            continue
        row_user = str(row.get("user_id") or "")
        log_id = new_log_id() if history_active(history, row_user, "test") else None
        if not sender_on:
            result, push_state = None, "disabled"
        else:
            payload = dict(TEST_PAYLOAD, url=history_url(log_id), target=TEST_PAYLOAD["url"])
            try:
                result = sender.send_push(row, payload, TTL_TEST, "high")
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] push test crashed: {type(exc).__name__}")
                result = PushResult.FAILED
            push_state = "ok" if result is PushResult.OK else "failed"
        if result is PushResult.OK:
            sent += 1
        _record_history(
            history, row_user, "test",
            TEST_PAYLOAD["title"], TEST_PAYLOAD["body"], TEST_PAYLOAD["url"], TEST_PAYLOAD["tag"], log_id,
            push_ok=1 if result is PushResult.OK else 0, push_total=1, ntfy_attempted=False, ntfy_ok=False,
            push_state=push_state, delivered=result is PushResult.OK,
        )
        if result is not PushResult.GONE and not _clear_test_flag(supabase, row):  # a deleted row has no flag
            print("[Deliver] push test flag not cleared; it is retried without sending the test again.")
            answered.add(key)
        label = result.value if isinstance(result, PushResult) else ("disabled" if not sender_on else "failed")
        print(f"[Deliver] push test for user {str(row.get('user_id') or '?')[:8]}: {label}")
    return sent
