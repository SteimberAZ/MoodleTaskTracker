"""Delivery of custom reminders stored in Supabase (table moodle_custom_reminders) to their owners.

A reminder is delivered at most once per fire time: after a delivery its row is advanced with a
conditional PATCH (only while ``next_fire_at`` still holds the delivered value), and a PATCH that did
not land is kept in memory and retried without sending again. A reminder linked to a task stops by
itself once the task is submitted or muted. A reminder whose deliveries keep failing is retried with
the bounded backoff of ``delivery.deliver_to_user``; once those retries are exhausted it skips to its
next occurrence (or ends), and a reminder whose end date passes while it is being retried still gets
its last attempt instead of expiring silently.
"""
import inspect
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, Tuple

import delivery

# kind and tag the worker's reminder deliverer (worker.reminder_deliverer) sends a reminder with; the
# bounded-retry state of delivery.deliver_to_user is keyed by them.
REMINDER_KIND = "reminder"
# A fire time whose end date passed while its delivery kept failing on our side (outages never
# exhaust a notification) is given up this long after the end date: longer than the largest backoff.
EXPIRED_RETRY_GRACE = timedelta(hours=2)


def reminder_tag(reminder_id) -> str:
    return f"reminder-{reminder_id}"

_TS_RE = re.compile(
    r"^(?P<base>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(?P<frac>\d+))?(?P<tz>Z|[+-]\d{2}(?::?\d{2})?)?$"
)


def parse_timestamptz(value) -> datetime:
    """Parse a Postgres timestamptz string into an aware UTC datetime."""
    if isinstance(value, datetime):
        dt = value
    else:
        m = _TS_RE.match(str(value).strip())
        if not m:
            raise ValueError(f"Unparseable timestamp: {value!r}")
        frac = (m.group("frac") or "")[:6].ljust(6, "0")
        tz = m.group("tz") or "+00:00"
        if tz == "Z":
            tz = "+00:00"
        elif len(tz) == 3:
            tz += ":00"
        elif len(tz) == 5:
            tz = tz[:3] + ":" + tz[3:]
        dt = datetime.fromisoformat(f"{m.group('base').replace(' ', 'T')}.{frac}{tz}")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def compute_next_fire(next_fire_at: datetime, interval_minutes: int, now: datetime) -> datetime:
    """Advance next_fire_at by whole intervals until it is strictly greater than now.

    Missed fires are skipped, so downtime never causes a burst of notifications.
    """
    if interval_minutes <= 0:
        raise ValueError("interval_minutes must be positive")
    step = timedelta(minutes=interval_minutes)
    if next_fire_at > now:
        return next_fire_at
    missed = (now - next_fire_at) // step
    return next_fire_at + step * (missed + 1)


def decide_action(reminder: Dict, now: datetime) -> Dict:
    """Pure decision for one reminder row.

    Returns {"action": "skip" | "stop_linked" | "expire" | "send", "patch": {...}}.
    - skip:        not due yet (or malformed row).
    - stop_linked: the linked task (embedded as ``task: {status, is_dismissed}``) was submitted or
                   muted; deactivate without sending. A missing / null embed never stops a reminder.
    - expire:      the end date has passed; deactivate without sending.
    - send:        notify, then apply the patch (last_sent_at / next_fire_at / updated_at / active).
    """
    try:
        next_fire = parse_timestamptz(reminder["next_fire_at"])
        ends_at = parse_timestamptz(reminder["ends_at"])
        interval = int(reminder["interval_minutes"])
    except (KeyError, TypeError, ValueError):
        return {"action": "skip", "patch": {}}

    now_iso = to_iso(now)
    task = reminder.get("task")
    if isinstance(task, dict) and (task.get("status") == "submitted" or task.get("is_dismissed")):
        return {"action": "stop_linked", "patch": {"active": False, "updated_at": now_iso}}

    if next_fire > now:
        return {"action": "skip", "patch": {}}
    if now > ends_at:
        return {"action": "expire", "patch": {"active": False, "updated_at": now_iso}}

    new_next = compute_next_fire(next_fire, interval, now)
    patch = {
        "last_sent_at": now_iso,
        "next_fire_at": to_iso(new_next),
        "updated_at": now_iso,
    }
    if new_next > ends_at:
        patch["active"] = False
    return {"action": "send", "patch": patch}


def owner_user(reminder: Dict) -> Optional[Dict]:
    """The reminder's owner as a delivery target, or None when it must not be delivered.

    The row embeds its owner as ``moodle_users: {ntfy_topic, active, ntfy_enabled[, ntfy_confirmed_at]}``
    (PostgREST join). A row with no user_id, no joined user, an inactive user or an empty topic is
    skipped, never sent anywhere. The result has the shape of the user rows the worker syncs:
    ``{"id", "ntfy_topic", "ntfy_enabled"}`` plus ``ntfy_confirmed_at`` when the embed carries it (a
    missing ntfy_enabled means off, see delivery.ntfy_enabled).
    """
    if not reminder.get("user_id"):
        return None
    user = reminder.get("moodle_users")
    if isinstance(user, list):  # tolerate a to-many embed shape
        user = user[0] if len(user) == 1 else None
    if not isinstance(user, dict) or user.get("active") is not True:
        return None
    topic = str(user.get("ntfy_topic") or "").strip()
    if not topic:
        return None
    owner = {
        "id": str(reminder["user_id"]),
        "ntfy_topic": topic,
        "ntfy_enabled": user.get("ntfy_enabled") is True,
    }
    if "ntfy_confirmed_at" in user:
        owner["ntfy_confirmed_at"] = user.get("ntfy_confirmed_at")
    return owner


def owner_topic(reminder: Dict) -> Optional[str]:
    """ntfy topic of the reminder's owner, or None when it must not be delivered."""
    owner = owner_user(reminder)
    return owner["ntfy_topic"] if owner else None


# (reminder id, next_fire_at that was already delivered) -> patch that still has to land. Filled when
# the PATCH after a delivery fails, so later ticks retry the patch instead of resending.
_UNPATCHED: Dict[Tuple[str, str], Dict] = {}


def _supports_expected(client) -> bool:
    """True when ``client.update_reminder`` takes ``expected_next_fire_at`` (a conditional PATCH)."""
    try:
        params = inspect.signature(client.update_reminder).parameters
    except (TypeError, ValueError, AttributeError):
        return False
    return "expected_next_fire_at" in params or any(p.kind is p.VAR_KEYWORD for p in params.values())


def _update(client, rid, patch: Dict, expected: Optional[str]):
    """PATCH one reminder: True = updated, None = the row moved on (0 rows matched), False = failed.

    Uses the conditional form when the client offers it, the plain one otherwise (True / False only).
    """
    if expected is not None and _supports_expected(client):
        try:
            return client.update_reminder(rid, patch, expected_next_fire_at=expected)
        except TypeError:
            pass
    return client.update_reminder(rid, patch)


def _save(client, pending: Dict[Tuple[str, str], Dict], rid: str, fire: str, patch: Dict, what: str) -> None:
    """Apply the patch after ``what`` happened; a failed write is kept in ``pending`` and retried."""
    result = _update(client, rid, patch, fire)
    if result is None:
        print(f"[Reminders] {rid[:8]}: {what}, but the row changed meanwhile; leaving it as it is.")
    elif result is False:
        print(f"[Reminders] {rid[:8]}: {what} but not saved; the update is retried, not the send.")
        pending[(rid, fire)] = patch


def process_due_reminders(
    client,
    send: Optional[Callable[[str, str, str], bool]] = None,
    now: Optional[datetime] = None,
    deliver: Optional[Callable[[Dict, Dict, str, str], bool]] = None,
    unpatched: Optional[Dict[Tuple[str, str], Dict]] = None,
) -> int:
    """Fetch due reminders, notify their owners and update them. Returns the number sent.

    ``deliver(owner, reminder, title, body)`` reaches every channel of the owner (Web Push and ntfy,
    see delivery.deliver_to_user); ``send(title, body, topic)`` is the ntfy-only alternative. Either
    returns True when the reminder got through; otherwise the row stays untouched and a later tick
    retries (inside the delivery backoff). Rows without an active owner are left untouched.

    After a delivery the row is advanced with ``client.update_reminder(id, patch,
    expected_next_fire_at=<delivered next_fire_at>)`` (True = saved, None = lost race: the row changed
    meanwhile and nothing is resent, False = failed). A failed update is kept in ``unpatched``
    (process-wide by default), keyed by (id, delivered next_fire_at): it is retried at the start of
    every call and that fire time is never delivered again. A client without the conditional form gets
    the plain update, retried only while the row still shows the delivered ``next_fire_at``.
    """
    if send is None and deliver is None:
        raise ValueError("process_due_reminders needs send or deliver")
    if not client.is_configured:
        return 0
    pending = _UNPATCHED if unpatched is None else unpatched
    now = now or datetime.now(timezone.utc)
    conditional = _supports_expected(client)
    held = set(pending)  # fire times already delivered: never sent again this call

    if conditional:
        for (rid, fire), patch in list(pending.items()):
            if _update(client, rid, patch, fire) is not False:  # saved, or the row moved on
                pending.pop((rid, fire), None)

    rows = client.fetch_due_reminders(to_iso(now))
    if not conditional:
        due = {(str(r.get("id")), str(r.get("next_fire_at"))) for r in rows}
        for key in list(pending):
            if key not in due:
                pending.pop(key, None)  # the row moved on (edited or patched elsewhere)
            elif client.update_reminder(key[0], pending[key]) is not False:
                pending.pop(key, None)

    sent = 0
    for reminder in rows:
        rid, fire = str(reminder.get("id")), str(reminder.get("next_fire_at"))
        if (rid, fire) in held or (rid, fire) in pending:
            continue  # already delivered for this fire time: only the update was missing
        owner = owner_user(reminder)
        if owner is None:
            continue
        decision = decide_action(reminder, now)
        action = decision["action"]
        if action == "skip":
            continue
        if action == "stop_linked":
            print(f"[Reminders] {rid[:8]}: its task was submitted or muted; reminder stopped.")
            _save(client, pending, rid, fire, decision["patch"], "stopped")
            continue
        tag = reminder_tag(reminder.get("id"))
        retrying = delivery.pending_attempts(owner["id"], REMINDER_KIND, tag) > 0
        expired_retry = action == "expire" and retrying
        if expired_retry:
            # The end date passed while a failed delivery waited for its retry: give it that retry.
            now_iso = to_iso(now)
            decision = {"action": "send", "patch": {"last_sent_at": now_iso, "updated_at": now_iso, "active": False}}
            action = "send"
        if action == "expire":
            print(f"[Reminders] {rid[:8]}: ended before its fire time {fire} was delivered; deactivated.")
            _update(client, reminder["id"], decision["patch"], fire)
            continue
        title = reminder.get("title") or "Recordatorio"
        body = reminder.get("message") or title
        if deliver is not None:
            delivered = deliver(owner, reminder, title, body)
        else:
            delivered = send(title, body, owner["ntfy_topic"])
        if delivered:
            sent += 1
            _save(client, pending, rid, fire, decision["patch"], "delivered")
            continue
        if delivery.is_exhausted(owner["id"], REMINDER_KIND, tag) or (
            expired_retry and now - parse_timestamptz(reminder["ends_at"]) > EXPIRED_RETRY_GRACE
        ):
            # Every bounded retry failed, or the reminder ended long ago (its natural expiry): skip this
            # occurrence instead of retrying it forever.
            patch = {k: v for k, v in decision["patch"].items() if k != "last_sent_at"}
            print(f"[Reminders] {rid[:8]}: fire time {fire} not delivered after every retry; moving on.")
            delivery.forget(owner["id"], REMINDER_KIND, tag)
            _save(client, pending, rid, fire, patch, "skipped")
        # else: leave the row untouched so a later tick retries
    return sent
