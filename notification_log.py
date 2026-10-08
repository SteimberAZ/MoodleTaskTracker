"""Per-user history of every notification the worker delivers (``moodle_notification_log``).

``deliver_to_user`` (and the push-test path) hand each outcome to ``NotificationLog.record``, which
only appends a row to an in-memory buffer. The worker calls ``flush`` once per tick (in a ``finally``,
so a crashing tick still writes what it delivered) and the whole tick goes out as ONE bulk insert.
Buffering instead of one POST per notification means a slow or unreachable database costs at most one
5-second stall per tick instead of one per notification, and no delivery ever waits on the history.

The history is best effort and must never affect delivery: nothing here raises, a failed insert is
dropped (not retried), and an outage or a missing table is logged once (``delivery._log_changed``)
until the next successful write.

Rows older than ``RETENTION_DAYS`` are deleted at most once every 24 hours (``prune_if_due``; the
time of the last run lives in the local settings table).
"""
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import delivery

KINDS = frozenset({"task", "reminder", "class", "status", "test"})
TITLE_MAX = 200
BODY_MAX = 1000
RETENTION_DAYS = 90
PRUNE_INTERVAL_SECONDS = 24 * 3600
PRUNE_SETTING = "notification_log_pruned_at"  # local only (storage.LOCAL_ONLY_SETTINGS)
FLUSH_CHUNK = 200  # rows per bulk insert request

_INSERT_KEY = "history-insert"
_PRUNE_KEY = "history-prune"
_RECORD_KEY = "history-buffer"


def clip(text: Any, limit: int) -> str:
    """``text`` as a string of at most ``limit`` characters (a cut one ends with an ellipsis)."""
    value = "" if text is None else str(text)
    return value if len(value) <= limit else value[: limit - 1] + "…"


def build_row(
    user_id: str,
    kind: str,
    title: Any,
    body: Any,
    url: Any,
    tag: Any,
    *,
    push_ok: int,
    push_total: int,
    ntfy_attempted: bool,
    ntfy_ok: bool,
    created_at: datetime,
) -> Dict[str, Any]:
    """One ``moodle_notification_log`` row. Every row carries exactly the same keys.

    PostgREST rejects a bulk insert whose rows have different key sets (PGRST102), so optional
    columns (``body``, ``url``, ``tag``) are always present and null when empty. ``status`` is
    ``sent`` when at least one channel accepted the notification, otherwise ``failed``.
    """
    delivered = push_ok > 0 or bool(ntfy_ok)
    return {
        "user_id": str(user_id),
        "kind": kind,
        "title": clip(title, TITLE_MAX),
        "body": clip(body, BODY_MAX) or None,
        "url": str(url) if url else None,
        "tag": str(tag) if tag else None,
        "status": "sent" if delivered else "failed",
        "push_ok": int(push_ok),
        "push_total": int(push_total),
        "ntfy_attempted": bool(ntfy_attempted),
        "ntfy_ok": bool(ntfy_ok),
        # Explicit, not the column default: now() is the same for a whole bulk insert, which would
        # make the rows of one tick indistinguishable when ordering the history.
        "created_at": created_at.astimezone(timezone.utc).isoformat(),
    }


def _is_missing_table(exc: Exception) -> bool:
    text = str(exc)
    return "PGRST205" in text or "42P01" in text or "HTTP 404" in text


class NotificationLog:
    """Buffered writer of the notification history. Never raises."""

    def __init__(self, supabase: Any, clock=None):
        self.supabase = supabase
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._rows: List[Dict[str, Any]] = []

    @property
    def enabled(self) -> bool:
        return self.supabase is not None and bool(getattr(self.supabase, "is_configured", False))

    @property
    def pending(self) -> int:
        return len(self._rows)

    def record(
        self,
        user_id: Any,
        kind: str,
        title: Any,
        body: Any = None,
        url: Any = None,
        tag: Any = None,
        *,
        push_ok: int = 0,
        push_total: int = 0,
        ntfy_attempted: bool = False,
        ntfy_ok: bool = False,
    ) -> None:
        """Buffer one user-notification outcome (no network). Ignored without a user id or a database."""
        try:
            if not user_id or not self.enabled:
                return
            if kind not in KINDS:
                delivery._log_changed(_RECORD_KEY, f"[History] unknown notification kind {kind!r}; not recorded.")
                return
            self._rows.append(
                build_row(
                    user_id, kind, title, body, url, tag,
                    push_ok=push_ok, push_total=push_total,
                    ntfy_attempted=ntfy_attempted, ntfy_ok=ntfy_ok,
                    created_at=self._clock(),
                )
            )
        except Exception as exc:  # noqa: BLE001 - the history must never break a delivery
            delivery._log_changed(_RECORD_KEY, f"[History] could not record a notification: {type(exc).__name__}")

    def flush(self) -> int:
        """Insert the buffered rows (one request per ``FLUSH_CHUNK``) and return how many were written.

        The buffer is emptied first and a failure is not retried: those rows are dropped.
        """
        rows, self._rows = self._rows, []
        if not rows:
            return 0
        written = 0
        try:
            for start in range(0, len(rows), FLUSH_CHUNK):
                chunk = rows[start : start + FLUSH_CHUNK]
                self.supabase.insert_notification_log(chunk)
                written += len(chunk)
            delivery._log_changed(_INSERT_KEY, None)
        except Exception as exc:  # noqa: BLE001
            if _is_missing_table(exc):
                message = (
                    "[History] moodle_notification_log does not exist yet (re-run supabase_schema.sql); "
                    "notifications are not recorded until it does."
                )
            else:
                message = f"[History] could not record {len(rows) - written} notification(s): {str(exc)[:200]}"
            delivery._log_changed(_INSERT_KEY, message)
        return written

    def prune_if_due(self, storage: Any, now: Optional[datetime] = None) -> bool:
        """Delete rows older than ``RETENTION_DAYS``, at most once per 24 hours. True when it ran OK.

        The attempt time is stored before deleting, so a failing database is retried tomorrow rather
        than on every tick.
        """
        try:
            if not self.enabled:
                return False
            now = now or self._clock()
            try:
                last = float(storage.get_setting(PRUNE_SETTING, "0") or 0)
            except ValueError:
                last = 0.0
            if now.timestamp() - last < PRUNE_INTERVAL_SECONDS:
                return False
            storage.set_setting(PRUNE_SETTING, str(int(now.timestamp())))
            cutoff = (now.astimezone(timezone.utc) - timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.supabase.prune_notification_log(cutoff)
            delivery._log_changed(_PRUNE_KEY, None)
            return True
        except Exception as exc:  # noqa: BLE001
            message = (
                "[History] moodle_notification_log does not exist yet; nothing to prune."
                if _is_missing_table(exc)
                else f"[History] could not prune the notification history: {str(exc)[:200]}"
            )
            delivery._log_changed(_PRUNE_KEY, message)
            return False
