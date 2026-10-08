"""One delivery path for every user-facing notification of the worker.

``deliver_to_user`` sends a notification through *all* channels of one user: native Web Push to each
of their installed-PWA subscriptions (the primary channel) and ntfy to their private topic (optional,
switched per user with ``moodle_users.ntfy_enabled``, on by default). Task milestones, custom
reminders, class reminders and "Moodle desconectado" alerts all go through it. The "Enviar prueba"
button (``process_push_tests``) targets one subscription, so it uses the same sender directly.

A delivery counts as successful when at least one channel accepted the message. Callers use that to
decide whether to record a milestone / advance a reminder, so a total failure is retried later.
"""
from typing import Any, Callable, Dict, Optional

import notifier
from webpush_sender import TTL_TASK, TTL_TEST, PushResult

HIGH_PRIORITIES = frozenset({"urgent", "max", "high", "4", "5"})

TEST_PAYLOAD = {
    "title": "Notificaciones activas ✅",
    "body": "Así te llegarán tus avisos de Moodle",
    "url": "/notificaciones",
    "tag": "test",
}

_last_logged: Dict[str, str] = {}


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
    supabase=None,
    sender=None,
    ntfy: Optional[Callable[..., bool]] = None,
) -> bool:
    """Send one notification to every channel of ``user``; True when at least one accepted it.

    ``user`` needs ``id`` (Web Push subscriptions), ``ntfy_topic`` and optionally ``ntfy_enabled``.
    ``url`` / ``tag`` go to the Web Push payload (a path inside the PWA; the tag replaces an older
    notification with the same tag). ``priority`` uses ntfy words and also picks the Web Push urgency.
    ``ntfy_tags`` / ``ntfy_link`` only shape the ntfy copy. A user without a topic is never routed to
    the owner's topic. Never raises.
    """
    user_id = str(user.get("id") or "")
    delivered = False
    parts = []

    # 1. Web Push (primary): every subscription the user registered from an installed PWA / browser.
    if sender is not None and getattr(sender, "enabled", False) and supabase is not None and user_id:
        try:
            subs = supabase.fetch_push_subscriptions(user_id)
            _log_changed(f"subs {user_id}", None)
        except Exception as exc:  # noqa: BLE001 - ntfy must still go out
            _log_changed(f"subs {user_id}", f"[Deliver] user {user_id[:8]}: could not read push subscriptions: {exc}")
            subs = []
        payload = {"title": title, "body": body, "url": url, "tag": tag}
        counts = {PushResult.OK: 0, PushResult.GONE: 0, PushResult.FAILED: 0}
        for sub in subs:
            try:
                result = sender.send_push(sub, payload, ttl, urgency_for(priority))
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] user {user_id[:8]}: push send crashed: {type(exc).__name__}")
                result = PushResult.FAILED
            counts[result if result in counts else PushResult.FAILED] += 1
        delivered = counts[PushResult.OK] > 0
        text = f"push {counts[PushResult.OK]}/{len(subs)} ok" if subs else "push none"
        parts.append(text + (f" ({counts[PushResult.GONE]} gone)" if counts[PushResult.GONE] else ""))
    else:
        parts.append("push off")

    # 2. ntfy (optional, per user).
    topic = str(user.get("ntfy_topic") or "").strip()
    if ntfy_enabled(user) and topic:
        post = ntfy or notifier.post_ntfy
        text = f"{body}\n🔗 {ntfy_link}" if ntfy_link else body
        try:
            ntfy_ok = bool(post(title, text, priority=priority, tags=ntfy_tags, topic=topic))
        except Exception as exc:  # noqa: BLE001
            print(f"[Deliver] user {user_id[:8]}: ntfy crashed: {type(exc).__name__}")
            ntfy_ok = False
        delivered = delivered or ntfy_ok
        parts.append("ntfy ok" if ntfy_ok else "ntfy failed")
    else:
        parts.append("ntfy off")

    print(f"[Deliver] user {user_id[:8] or '?'}: {', '.join(parts)} -> {'delivered' if delivered else 'NOT delivered'}")
    return delivered


def process_push_tests(supabase, sender) -> int:
    """Answer the "Enviar prueba" button: send a test push to every subscription that asked for one.

    The web sets ``test_requested_at`` on the row; this clears it again, also when the send failed or
    raised, so a broken subscription cannot loop. Returns how many tests were accepted. Never raises
    for a single row, and does nothing without a working sender / database.
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
    sent = 0
    for row in rows:
        try:
            result = sender.send_push(row, TEST_PAYLOAD, TTL_TEST, "high")
        except Exception as exc:  # noqa: BLE001
            print(f"[Deliver] push test crashed: {type(exc).__name__}")
            result = PushResult.FAILED
        if result is PushResult.OK:
            sent += 1
        if result is not PushResult.GONE:  # a deleted row has no flag left to clear
            try:
                supabase.update_push_subscription(row["id"], {"test_requested_at": None})
            except Exception as exc:  # noqa: BLE001
                print(f"[Deliver] could not clear the push test flag: {type(exc).__name__}")
        label = result.value if isinstance(result, PushResult) else "failed"
        print(f"[Deliver] push test for user {str(row.get('user_id') or '?')[:8]}: {label}")
    return sent
