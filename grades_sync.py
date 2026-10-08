"""Per-user grade statistics sync and the "Te calificaron" alerts.

Runs after a successful task sync (``api_sync``) and never raises: ``sync_user_grades`` returns
``"skipped"``, ``"not_due"``, ``"ok"`` or ``"error"``. The Supabase table ``moodle_grade_items`` is the
store (the web reads it); there is no SQLite mirror.

Dedupe rules:
  * ``notified_grade`` (a grade signature such as ``"17.00"``) is stored with each row and is the durable
    record of the last grade announced for an item; a different grade alerts again, a cleared grade
    resets it so a later grade alerts again;
  * the first successful fetch of a course for a user is baselined: every current grade is recorded as
    already announced, so deploying or a new user never sends a burst (a course that left and came back
    is baselined again);
  * only graded activities (``mod`` / ``manual``) alert; course and category totals never do;
  * a local milestone ``grade:<user>:<course>:<item>`` with the signature as its value blocks a resend
    when the Supabase write failed after the alert went out;
  * at most ``MAX_ALERTS_PER_RUN`` alerts per run; the rest stay pending for the next run.
"""
import math
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional, Tuple

import delivery

STATS_PATH = "/estadisticas"
# Course and category totals never alert; only graded activities do.
GRADE_LEAF_TYPES = frozenset({"mod", "manual"})
MAX_ALERTS_PER_RUN = 10
# The history CHECK allows task|reminder|class|status|test; a grade is about a task.
ALERT_KIND = "task"

_LOGGED: Dict[str, str] = {}


def _log_changed(key: str, message: Optional[str]) -> None:
    """Print ``message`` only when it differs from the last one for ``key`` (None = healthy again)."""
    if message is None:
        _LOGGED.pop(key, None)
    elif _LOGGED.get(key) != message:
        _LOGGED[key] = message
        print(message)


def _quantize(value: Any) -> Optional[Decimal]:
    """``value`` rounded half up to two decimals, or None when it is not a finite number."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    try:
        return Decimal(str(number)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except InvalidOperation:
        return None


def grade_signature(row: Dict) -> Optional[str]:
    """Stable text of the row's grade (``"17.00"``), or None when it has no numeric grade."""
    q = _quantize(row.get("grade_raw"))
    return None if q is None else format(q, "f")


def format_points(value: Any) -> str:
    """Points for people: no trailing zeros and a decimal comma (17 -> "17", 8.5 -> "8,5"); "-" if not a number."""
    q = _quantize(value)
    if q is None:
        return "-"
    text = format(q, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text.replace(".", ",")


def grade_local_key(user_id: Any, course_id: Any, item_id: Any) -> str:
    """Local task_milestones key of a grade alert; the milestone value is the grade signature."""
    return f"grade:{user_id}:{int(course_id)}:{int(item_id)}"


def grade_retry_key(course_id: Any, item_id: Any, signature: str) -> str:
    """Bounded-retry key of one grade alert (a new grade for the item is a new notification)."""
    return f"grade-{int(course_id)}-{int(item_id)}:{signature}"


def grade_alert_text(row: Dict, changed: bool) -> Tuple[str, str]:
    """(title, body) of the alert for a graded item; ``changed`` is True when a grade was already announced."""
    title = "Calificación actualizada" if changed else "Nueva calificación"
    name = row.get("item_name") or "Actividad"
    score = format_points(row.get("grade_raw"))
    if _quantize(row.get("grade_max")) is not None:
        score += "/" + format_points(row.get("grade_max"))
    course = row.get("course_name") or "Materia no especificada"
    return title, f"Te calificaron: {name} — {score} ({course})"


def _send_alert(storage, deliver: Callable, user: Dict, item: Dict, cid: int, iid: int, sig: str,
                changed: bool, label: str) -> bool:
    """Send one grade alert; True when it is settled (delivered, or given up after every retry)."""
    user_id = str(user.get("id") or "")
    title, body = grade_alert_text(item, changed)
    retry = grade_retry_key(cid, iid, sig)
    try:
        delivered = bool(deliver(
            user, title, body, url=STATS_PATH, tag=f"grade-{cid}-{iid}", priority="default",
            ntfy_tags="mortarboard", kind=ALERT_KIND, renotify=True, retry_key=retry,
        ))
    except Exception:  # noqa: BLE001 - a failed alert stays pending
        delivered = False
    if not delivered and delivery.is_exhausted(user_id, ALERT_KIND, retry):
        print(f"{label} grade alert for item {iid} not delivered after every retry; giving up.")
        delivery.forget(user_id, ALERT_KIND, retry)
        delivered = True
    if delivered:
        storage.record_milestone(grade_local_key(user_id, cid, iid), sig, mirror=False)
    return delivered


def _usable(obj: Any, *names: str) -> bool:
    return all(callable(getattr(obj, name, None)) for name in names)


def sync_user_grades(storage, supabase: Any, client: Any, user: Dict, deliver: Optional[Callable] = None,
                     label: str = "[Grades]", now: Optional[float] = None) -> str:
    """Store the user's grade items in Supabase and alert on newly graded activities. Never raises.

    Returns ``"skipped"`` (no user, no configured Supabase or a client/store without grade support),
    ``"not_due"`` (the client's cadence says not yet), ``"ok"`` or ``"error"``.
    """
    try:
        user_id = str(user.get("id") or "")
        if not user_id or supabase is None or not getattr(supabase, "is_configured", False):
            return "skipped"
        if not _usable(client, "grades_due", "fetch_course_grades"):
            return "skipped"
        if not _usable(supabase, "fetch_grade_items", "upsert_grade_items"):
            return "skipped"
        if not client.grades_due(now=now):
            return "not_due"

        # Read the stored rows first: a missing table or a Supabase outage must not cost a Moodle round trip.
        try:
            stored_rows = supabase.fetch_grade_items(user_id) or []
        except Exception as e:  # noqa: BLE001
            text = str(e)
            if any(marker in text for marker in ("404", "PGRST205", "42P01")):
                _log_changed("grades-read", f"{label} grades not synced: moodle_grade_items does not exist yet "
                                            "(re-run supabase_schema.sql).")
            else:
                _log_changed("grades-read", f"{label} grades not synced: could not read moodle_grade_items "
                                            f"({type(e).__name__}).")
            return "error"
        _log_changed("grades-read", None)

        fetched = client.fetch_course_grades(now=now)
        if not fetched:
            return "error"

        stored: Dict[Tuple[int, int], Dict] = {}
        for r in stored_rows:
            try:
                stored[(int(r["course_id"]), int(r["item_id"]))] = r
            except (KeyError, TypeError, ValueError):
                continue
        stored_courses = {cid for cid, _ in stored}
        failed = {int(c) for c in fetched.get("failed") or []}
        fetched_at = datetime.now(timezone.utc).isoformat()
        rows_out: List[Dict] = []
        kept: Dict[int, List[int]] = {}
        alerts = 0

        for course in fetched.get("courses") or []:
            cid = int(course["id"])
            if cid in failed:
                continue  # its stored rows stay untouched: not upserted, not deleted
            baseline = cid not in stored_courses
            kept[cid] = []
            for item in (fetched.get("items") or {}).get(cid) or []:
                iid = int(item["item_id"])
                prev = stored.get((cid, iid))
                sig = grade_signature(item)
                notified = (prev or {}).get("notified_grade")
                if sig is None:
                    notified = None  # grade removed or not graded: a later grade alerts again
                elif sig == notified:
                    pass
                elif baseline or deliver is None or item.get("item_type") not in GRADE_LEAF_TYPES:
                    notified = sig  # no channel / totals never alert / first fetch of the course
                elif storage.has_notified_milestone(grade_local_key(user_id, cid, iid), sig):
                    notified = sig  # already sent; a previous database write failed
                elif alerts >= MAX_ALERTS_PER_RUN:
                    pass  # stays pending for the next run
                else:
                    alerts += 1
                    changed = (prev or {}).get("notified_grade") is not None
                    if _send_alert(storage, deliver, user, item, cid, iid, sig, changed, label):
                        notified = sig
                rows_out.append(dict(item, user_id=user_id, course_id=cid, item_id=iid,
                                     notified_grade=notified, fetched_at=fetched_at))
                kept[cid].append(iid)

        if not supabase.upsert_grade_items(user_id, rows_out):
            print(f"{label} grade items not saved (see [Supabase] log); retried next round.")
            return "error"

        # Best effort cleanup after a successful save (results are logged by the client).
        if callable(getattr(supabase, "delete_grade_items", None)):
            for cid, ids in kept.items():
                supabase.delete_grade_items(user_id, cid, ids)
        if callable(getattr(supabase, "delete_grade_courses", None)):
            supabase.delete_grade_courses(user_id, [int(c["id"]) for c in fetched.get("courses") or []])

        summary = f"{label} grades: {len(rows_out)} item(s) in {len(kept)} course(s), {alerts} alert(s)"
        if failed:
            summary += f", {len(failed)} course(s) not read"
        print(summary)
        return "ok"
    except Exception as e:  # noqa: BLE001 - grades never affect the task sync
        print(f"{label} grade sync failed: {type(e).__name__}")
        return "error"
