"""Delivery of custom reminders stored in Supabase (table moodle_custom_reminders) via ntfy."""
import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Optional

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


def process_due_reminders(client, send: Callable[[str, str], bool], now: Optional[datetime] = None) -> int:
    """Fetch due reminders, notify and update them. Returns the number of reminders sent."""
    if not client.is_configured:
        return 0
    now = now or datetime.now(timezone.utc)
    sent = 0
    for reminder in client.fetch_due_reminders(to_iso(now)):
        decision = decide_action(reminder, now)
        if decision["action"] == "skip":
            continue
        if decision["action"] == "send":
            title = reminder.get("title") or "Recordatorio"
            body = reminder.get("message") or title
            if not send(title, body):
                # Leave the row untouched so the next tick retries.
                continue
            sent += 1
        client.update_reminder(reminder["id"], decision["patch"])
    return sent
