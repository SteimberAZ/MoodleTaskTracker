"""Class reminders from each user's imported schedule (``moodle_class_schedule``).

The web stores the classes a user imported from the SGA "Horario de clases" PDF, plus one lead time
per user (``moodle_users.class_reminder_minutes``: 30, 60 or 180; null = off). Every worker tick
this module sends, once per class and local date, a notification while the class is inside its
lead window: ``start - lead <= now < start`` (a late tick still warns before the class begins).

Times are wall-clock Ecuador (UTC-5, no DST), the same zone the PDF is printed in. The weekday is
ISO: 1 = Monday ... 7 = Sunday, as ``moodle_class_schedule.weekday`` stores it.
"""
import re
from datetime import date, datetime, time as dtime, timedelta
from typing import Any, Callable, Dict, List, Optional, Tuple

import delivery
from class_schedule import ECUADOR_TZ

# Spanish small words stay lowercase inside a title (never the first word).
SMALL_WORDS = frozenset({"de", "del", "la", "las", "los", "y", "e", "en", "a"})
ROMAN_NUMERALS = frozenset({"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"})
_ACRONYM = re.compile(r"^\([A-ZÁÉÍÓÚÑ]{2,5}\)[.,;:]?$")  # "(EMI)" keeps its capitals
_PUNCT = "()[].,;:\"'"

NTFY_TAGS = "alarm_clock,mortarboard,books"
CLASSES_URL = "/horario"
MIN_TTL = 60
MILESTONE = "sent"


def _cap_word(word: str) -> str:
    """Lowercase ``word`` and capitalize its first letter (skipping leading punctuation)."""
    word = word.lower()
    for i, ch in enumerate(word):
        if ch.isalpha():
            return word[:i] + ch.upper() + word[i + 1 :]
    return word


def title_case(text: Any) -> str:
    """Title-case SGA's upper-case text the Spanish way.

    ``INTRODUCCIÓN A LA INVESTIGACIÓN CIENTÍFICA (EMI)`` -> ``Introducción a la Investigación
    Científica (EMI)``. Small words (de, del, la, las, los, y, e, en, a) stay lowercase except as the
    first word; roman numerals and parenthesised acronyms stay upper-case.
    """
    out = []
    for i, word in enumerate(str(text or "").split()):
        core = word.strip(_PUNCT)
        if _ACRONYM.match(word):
            out.append(word)
        elif core.upper() in ROMAN_NUMERALS:
            out.append(word.upper())
        elif i > 0 and core.lower() in SMALL_WORDS:
            out.append(word.lower())
        else:
            out.append("-".join(_cap_word(part) for part in word.split("-")))
    return " ".join(out)


def lead_label(minutes: int) -> str:
    """``30`` -> ``30 min``, ``60`` -> ``1 hora``, ``180`` -> ``3 horas``."""
    if minutes >= 60 and minutes % 60 == 0:
        hours = minutes // 60
        return "1 hora" if hours == 1 else f"{hours} horas"
    return f"{minutes} min"


def _clean(value: Any) -> str:
    text = str(value or "").strip()
    return "" if text in ("—", "-", "–") else text


def parse_time(value: Any) -> Optional[dtime]:
    """``"07:00:00"`` / ``"07:00"`` -> ``time``; None when it is not a time."""
    text = str(value or "").strip()
    for fmt in ("%H:%M:%S", "%H:%M"):
        try:
            return datetime.strptime(text, fmt).time()
        except ValueError:
            continue
    return None


def class_message(row: Dict, lead_minutes: int) -> Tuple[str, str]:
    """Title and body of one class reminder (missing optional parts are left out)."""
    title = f"📚 Clase en {lead_label(lead_minutes)}: {title_case(row.get('subject')) or 'Clase'}"
    parallel = _clean(row.get("parallel")).strip("\"'")
    if parallel:
        title += f" ({parallel})"

    start, end = parse_time(row.get("start_time")), parse_time(row.get("end_time"))
    lines = []
    if start and end:
        lines.append(f"🕘 {start:%H:%M}–{end:%H:%M}")
    elif start:
        lines.append(f"🕘 {start:%H:%M}")

    room = " ".join(p for p in (title_case(_clean(row.get("room_type"))), _clean(row.get("room_code"))) if p)
    floor = _clean(row.get("floor"))
    where = ", ".join(p for p in (room, f"piso {floor}" if floor else "") if p)
    if not where:
        where = title_case(_clean(row.get("place")))
    if where:
        lines.append(f"📍 {where}")

    teacher = title_case(_clean(row.get("teacher")))
    if teacher:
        lines.append(f"👨‍🏫 {teacher}")
    return title, "\n".join(lines)


def in_reminder_window(start: datetime, lead_minutes: int, now: datetime) -> bool:
    """True from ``lead_minutes`` before ``start`` until the class starts (the start itself is out)."""
    return start - timedelta(minutes=lead_minutes) <= now < start


def _past_period_end(row: Dict, today: date) -> bool:
    raw = row.get("period_end")
    if not raw:
        return False
    try:
        return today > date.fromisoformat(str(raw)[:10])
    except ValueError:
        return False  # an unreadable end date must not silence the reminders


def _lead_minutes(user: Dict) -> Optional[int]:
    try:
        minutes = int(user.get("class_reminder_minutes"))
    except (TypeError, ValueError):
        return None
    return minutes if minutes > 0 else None


def process_class_reminders(
    storage,
    supabase,
    deliver: Optional[Callable],
    now: Optional[datetime] = None,
) -> int:
    """Send the class reminders that are due now; returns how many were delivered.

    Reads the users with reminders on, then their classes for today's ISO weekday in Ecuador. A class
    is recorded (``class:<id>:<YYYY-MM-DD>``) only after ``deliver`` reached at least one channel, so a
    total failure is retried on the next tick while the class has not started. Never raises: an
    unreachable database or one malformed row is logged and skipped.
    """
    if deliver is None or supabase is None or not getattr(supabase, "is_configured", False):
        return 0
    now_ec = (now or datetime.now(ECUADOR_TZ)).astimezone(ECUADOR_TZ)
    today = now_ec.date()

    try:
        users = {
            str(u["id"]): u
            for u in supabase.fetch_class_reminder_users()
            if isinstance(u, dict) and u.get("id") and _lead_minutes(u)
        }
        rows = supabase.fetch_class_schedule(list(users), now_ec.isoweekday()) if users else []
        delivery._log_changed("class-reminders", None)
    except Exception as exc:  # noqa: BLE001 - the loop must survive any outage
        delivery._log_changed("class-reminders", f"[ClassReminders] could not read the class schedule: {exc}")
        return 0

    sent = 0
    for row in sorted(rows, key=lambda r: str(r.get("start_time") or "")):
        try:
            user = users.get(str(row.get("user_id")))
            start_time = parse_time(row.get("start_time"))
            if user is None or start_time is None or _past_period_end(row, today):
                continue
            lead = _lead_minutes(user)
            start = datetime.combine(today, start_time, tzinfo=ECUADOR_TZ)
            if not in_reminder_window(start, lead, now_ec):
                continue
            key = f"class:{row['id']}:{today.isoformat()}"
            if storage.has_notified_milestone(key, MILESTONE):
                continue
            title, body = class_message(row, lead)
            ttl = max(MIN_TTL, int((start - now_ec).total_seconds()))
            ok = deliver(
                user,
                title,
                body,
                url=CLASSES_URL,
                tag=f"class-{row['id']}-{today.isoformat()}",
                priority="high",
                ttl=ttl,
                ntfy_tags=NTFY_TAGS,
            )
            if ok:
                storage.record_milestone(key, MILESTONE, mirror=False)
                sent += 1
            # else: nothing got through; not recorded, so the next tick retries inside the window
        except Exception as exc:  # noqa: BLE001
            print(f"[ClassReminders] error with class {row.get('id')}: {exc}")
    return sent
