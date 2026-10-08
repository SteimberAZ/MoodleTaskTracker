"""One delivery path for every user-facing notification of the worker.

``deliver_to_user`` sends a notification through *all* channels of one user: native Web Push to each
of their installed-PWA subscriptions (the primary channel) and ntfy to their private topic (optional,
switched per user with ``moodle_users.ntfy_enabled``, on by default). Task milestones, custom
reminders, class reminders and "Moodle desconectado" alerts all go through it. The "Enviar prueba"
button (``process_push_tests``) targets one subscription, so it uses the same sender directly.
Every attempt for a user is also handed to ``history`` (notification_log.NotificationLog) with its
``kind`` and per-channel outcome, so the web can list it; that never affects the delivery result.

A delivery counts as successful when at least one channel accepted the message. Callers use that to
decide whether to record a milestone / advance a reminder, so a total failure is retried later.
"""
import os
import uuid
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

_last_logged: Dict[str, str] = {}


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
    """ntfy is on unless the user switched it off; a missing column / value means on."""
    return user.get("ntfy_enabled") is not False


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
) -> bool:
    """Send one notification to every channel of ``user``; True when at least one accepted it.

    ``user`` needs ``id`` (Web Push subscriptions), ``ntfy_topic`` and optionally ``ntfy_enabled``.
    ``url`` is the page the notification is about (a path inside the PWA); ``tag`` replaces an older
    notification with the same tag. ``priority`` uses ntfy words and also picks the Web Push urgency.
    ``ntfy_tags`` / ``ntfy_link`` only shape the ntfy copy. A user without a topic is never routed to
    the owner's topic. ``kind`` (task / reminder / class / status / test) and ``history`` record this
    attempt in the user's notification history; without either nothing is recorded. Never raises.

    Tapping a notification opens its own entry in Avisos: the history row id is generated here, before
    sending, and the push payload carries ``url=/notificaciones?n=<id>`` plus the original page as
    ``target`` (the row keeps it in its ``url`` column, so Avisos can offer an "Abrir" button). When
    nothing is recorded the payload links to plain ``/notificaciones``. With ``WEB_APP_URL`` set the
    ntfy copy gets the same link as its click action.
    """
    user_id = str(user.get("id") or "")
    log_id = new_log_id() if history_active(history, user_id, kind) else None
    link = history_url(log_id)
    delivered = False
    parts = []
    push_ok = push_total = 0
    ntfy_attempted = ntfy_ok = False

    # 1. Web Push (primary): every subscription the user registered from an installed PWA / browser.
    if sender is not None and getattr(sender, "enabled", False) and supabase is not None and user_id:
        subs_unreadable = False
        try:
            subs = supabase.fetch_push_subscriptions(user_id)
            _log_changed(f"subs {user_id}", None)
        except Exception as exc:  # noqa: BLE001 - ntfy must still go out
            _log_changed(f"subs {user_id}", f"[Deliver] user {user_id[:8]}: could not read push subscriptions: {exc}")
            subs, subs_unreadable = [], True
        payload = {"title": title, "body": body, "url": link, "target": url, "tag": tag}
        counts = {PushResult.OK: 0, PushResult.GONE: 0, PushResult.FAILED: 0}
        for sub in subs:
            try:
                result = sender.send_push(sub, payload, ttl, urgency_for(priority))
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] user {user_id[:8]}: push send crashed: {type(exc).__name__}")
                result = PushResult.FAILED
            counts[result if result in counts else PushResult.FAILED] += 1
        push_ok, push_total = counts[PushResult.OK], len(subs)
        delivered = push_ok > 0
        text = f"push {counts[PushResult.OK]}/{len(subs)} ok" if subs else "push none"
        if subs_unreadable:
            push_total, text = PUSH_UNKNOWN, "push FAILED (subscriptions unreadable)"
        parts.append(text + (f" ({counts[PushResult.GONE]} gone)" if counts[PushResult.GONE] else ""))
    else:
        parts.append("push off")

    # 2. ntfy (optional, per user).
    topic = str(user.get("ntfy_topic") or "").strip()
    if ntfy_enabled(user) and topic:
        ntfy_attempted = True
        post = ntfy or notifier.post_ntfy
        text = f"{body}\n🔗 {ntfy_link}" if ntfy_link else body
        click = absolute_web_url(link)
        extra = {"click": click} if click else {}  # only passed when configured: custom senders stay compatible
        try:
            ntfy_ok = bool(post(title, text, priority=priority, tags=ntfy_tags, topic=topic, **extra))
        except Exception as exc:  # noqa: BLE001
            print(f"[Deliver] user {user_id[:8]}: ntfy crashed: {type(exc).__name__}")
            ntfy_ok = False
        delivered = delivered or ntfy_ok
        parts.append("ntfy ok" if ntfy_ok else "ntfy failed")
    else:
        parts.append("ntfy off")

    print(f"[Deliver] user {user_id[:8] or '?'}: {', '.join(parts)} -> {'delivered' if delivered else 'NOT delivered'}")
    _record_history(
        history, user_id, kind, title, body, url, tag, log_id,
        push_ok=push_ok, push_total=push_total, ntfy_attempted=ntfy_attempted, ntfy_ok=ntfy_ok,
    )
    return delivered


# (subscription id, test_requested_at) of tests already sent whose flag could not be cleared yet.
_ANSWERED_TESTS: Set[Tuple[str, str]] = set()


def process_push_tests(supabase, sender, history=None, answered: Optional[Set[Tuple[str, str]]] = None) -> int:
    """Answer the "Enviar prueba" button: send a test push to every subscription that asked for one.

    The web sets ``test_requested_at`` on the row; this clears it again, also when the send failed or
    raised, so a broken subscription cannot loop. The clear only matches the value that was read, so a
    newer press made meanwhile survives and gets its own test. A request whose clear failed is kept in
    ``answered`` (process-wide by default) and is never sent twice: later ticks only retry the clear.
    Returns how many tests were accepted. Never raises for a single row, and does nothing without a
    working sender / database. Each test is recorded in ``history`` as kind "test" (one device, so
    push 1/1 or 0/1).
    """
    if sender is None or not getattr(sender, "enabled", False):
        return 0
    if supabase is None or not getattr(supabase, "is_configured", False):
        return 0
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
            try:
                if supabase.clear_push_test_request(row["id"], row.get("test_requested_at")):
                    answered.discard(key)
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] could not clear the push test flag: {type(exc).__name__}")
            continue
        row_user = str(row.get("user_id") or "")
        log_id = new_log_id() if history_active(history, row_user, "test") else None
        payload = dict(TEST_PAYLOAD, url=history_url(log_id), target=TEST_PAYLOAD["url"])
        try:
            result = sender.send_push(row, payload, TTL_TEST, "high")
        except Exception as exc:  # noqa: BLE001
            print(f"[Deliver] push test crashed: {type(exc).__name__}")
            result = PushResult.FAILED
        if result is PushResult.OK:
            sent += 1
        _record_history(
            history, row_user, "test",
            TEST_PAYLOAD["title"], TEST_PAYLOAD["body"], TEST_PAYLOAD["url"], TEST_PAYLOAD["tag"], log_id,
            push_ok=1 if result is PushResult.OK else 0, push_total=1, ntfy_attempted=False, ntfy_ok=False,
        )
        if result is not PushResult.GONE:  # a deleted row has no flag left to clear
            try:
                cleared = bool(supabase.clear_push_test_request(row["id"], row.get("test_requested_at")))
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] could not clear the push test flag: {type(exc).__name__}")
                cleared = False
            if not cleared:
                print("[Deliver] push test flag not cleared; it is retried without sending the test again.")
                answered.add(key)
        label = result.value if isinstance(result, PushResult) else "failed"
        print(f"[Deliver] push test for user {str(row.get('user_id') or '?')[:8]}: {label}")
    return sent
