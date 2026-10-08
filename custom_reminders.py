"""Delivery of custom reminders stored in Supabase (table moodle_custom_reminders) to their owners."""
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional, Tuple

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

    Returns {"action": "skip" | "expire" | "send", "patch": {...}}.
    - skip:   not due yet (or malformed row).
    - expire: the end date has passed; deactivate without sending.
    - send:   notify, then apply the patch (last_sent_at / next_fire_at / updated_at / active).
    """
    try:
        next_fire = parse_timestamptz(reminder["next_fire_at"])
        ends_at = parse_timestamptz(reminder["ends_at"])
        interval = int(reminder["interval_minutes"])
    except (KeyError, TypeError, ValueError):
        return {"action": "skip", "patch": {}}

    if next_fire > now:
        return {"action": "skip", "patch": {}}

    now_iso = to_iso(now)
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

    The row embeds its owner as ``moodle_users: {ntfy_topic, active, ntfy_enabled}`` (PostgREST
    join). A row with no user_id, no joined user, an inactive user or an empty topic is skipped, never
    sent anywhere. The result has the shape of the user rows the worker syncs:
    ``{"id", "ntfy_topic", "ntfy_enabled"}`` (a missing ntfy_enabled means on).
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
    return {
        "id": str(reminder["user_id"]),
        "ntfy_topic": topic,
        "ntfy_enabled": user.get("ntfy_enabled") is not False,
    }


def owner_topic(reminder: Dict) -> Optional[str]:
    """ntfy topic of the reminder's owner, or None when it must not be delivered."""
    owner = owner_user(reminder)
    return owner["ntfy_topic"] if owner else None


# reminder id -> (next_fire_at that was already delivered, patch that still has to land). Filled when
# the PATCH after a successful delivery fails, so the next tick retries the patch instead of resending.
_UNPATCHED: Dict[str, Tuple[str, Dict]] = {}


def process_due_reminders(
    client,
    send: Optional[Callable[[str, str, str], bool]] = None,
    now: Optional[datetime] = None,
    deliver: Optional[Callable[[Dict, Dict, str, str], bool]] = None,
    unpatched: Optional[Dict[str, Tuple[str, Dict]]] = None,
) -> int:
    """Fetch due reminders, notify their owners and update them. Returns the number sent.

    ``deliver(owner, reminder, title, body)`` reaches every channel of the owner (Web Push and ntfy,
    see delivery.deliver_to_user); ``send(title, body, topic)`` is the ntfy-only alternative. Either
    returns True when the reminder got through; otherwise the row stays untouched and the next tick
    retries. Rows without an active owner are left untouched.

    When the update after a delivery fails, the delivered ``next_fire_at`` and its patch are kept in
    ``unpatched`` (process-wide by default): later ticks only retry the patch, never the delivery,
    while the row still shows that same ``next_fire_at``.
    """
    if send is None and deliver is None:
        raise ValueError("process_due_reminders needs send or deliver")
    if not client.is_configured:
        return 0
    pending = _UNPATCHED if unpatched is None else unpatched
    now = now or datetime.now(timezone.utc)
    sent = 0
    for reminder in client.fetch_due_reminders(to_iso(now)):
        rid = str(reminder.get("id"))
        held = pending.get(rid)
        if held is not None:
            if held[0] == str(reminder.get("next_fire_at")):
                # Already delivered for this fire time: only the update is missing.
                if client.update_reminder(reminder["id"], held[1]) is not False:
                    pending.pop(rid, None)
                continue
            pending.pop(rid, None)  # the row moved on (edited or patched elsewhere)
        owner = owner_user(reminder)
        if owner is None:
            continue
        decision = decide_action(reminder, now)
        if decision["action"] == "skip":
            continue
        if decision["action"] == "send":
            title = reminder.get("title") or "Recordatorio"
            body = reminder.get("message") or title
            if deliver is not None:
                delivered = deliver(owner, reminder, title, body)
            else:
                delivered = send(title, body, owner["ntfy_topic"])
            if not delivered:
                # Leave the row untouched so the next tick retries.
                continue
            sent += 1
            if client.update_reminder(reminder["id"], decision["patch"]) is False:
                print(f"[Reminders] {rid[:8]}: delivered but not updated; the update is retried, not the send.")
                pending[rid] = (str(reminder.get("next_fire_at")), decision["patch"])
            continue
        client.update_reminder(reminder["id"], decision["patch"])
    return sent
