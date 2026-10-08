"""Per-user history of every notification the worker delivers (``moodle_notification_log``).

``deliver_to_user`` (and the push-test path) hand each outcome to ``NotificationLog.record``, which
only appends a row to an in-memory buffer. The worker calls ``flush`` after each delivery phase of a
tick (reminders, then each synced user) and once more in a ``finally``, so a crashing tick still writes
what it delivered. Each flush goes out as ONE bulk insert, so the row a push links to
(``/notificaciones?n=<id>``) exists within seconds of the push, not only at the end of a long tick,
and no delivery ever waits on the history.

The history is best effort and must never affect delivery: nothing here raises. Rows of a failed
insert stay buffered and are retried on the next flushes until they are ``MAX_ROW_AGE_SECONDS`` old
(retention by age, not by flush count: the worker flushes several times a minute, so a count would
drop rows within a short outage); the buffer never holds more than ``MAX_BUFFERED_ROWS``. A missing
table drops them. A chunk refused because of one bad row (409, or a constraint or data error such
as the FK of a deleted user) is retried row by row so only the bad rows are dropped. An outage or a
missing table is logged once (``delivery._log_changed``) until the next successful write.

Rows older than ``RETENTION_DAYS`` are deleted at most once every 24 hours (``prune_if_due``; the
time of the last run lives in the local settings table).
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import delivery

KINDS = frozenset({"task", "reminder", "class", "status", "test"})
# moodle_notification_log.push_state: what happened on the Web Push channel of one attempt.
PUSH_STATES = frozenset({"ok", "partial", "failed", "no_devices", "read_error", "disabled"})
TITLE_MAX = 200
BODY_MAX = 1000
RETENTION_DAYS = 90
PRUNE_INTERVAL_SECONDS = 24 * 3600
PRUNE_SETTING = "notification_log_pruned_at"  # local only (storage.LOCAL_ONLY_SETTINGS)
FLUSH_CHUNK = 200  # rows per bulk insert request
MAX_ROW_AGE_SECONDS = 6 * 3600  # an unwritten row is retried until it is this old
MAX_BUFFERED_ROWS = 2000  # oldest rows are dropped beyond this during a long outage
# PostgREST/Postgres errors caused by the rows themselves, not by the server: retrying the same
# chunk can never succeed, so it is split to find the bad rows.
_ROW_ERROR_MARKERS = ("HTTP 409", "23503", "23514", "23502", "22P02", "22001", "22007", "22003")

_INSERT_KEY = "history-insert"
_PRUNE_KEY = "history-prune"
_RECORD_KEY = "history-buffer"
_DROP_KEY = "history-dropped"


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
    log_id: Optional[str] = None,
    push_state: Optional[str] = None,
    delivered: Optional[bool] = None,
) -> Dict[str, Any]:
    """One ``moodle_notification_log`` row. Every row carries exactly the same keys.

    PostgREST rejects a bulk insert whose rows have different key sets (PGRST102), so optional
    columns (``body``, ``url``, ``tag``, ``push_state``) are always present and null when empty.
    ``status`` is ``sent`` when the notification really reached the user: ``delivered`` as decided by
    ``delivery.deliver_to_user`` (an unconfirmed ntfy copy does not count), or, without it, at least
    one accepted channel. ``push_state`` is one of PUSH_STATES (unknown values are stored as null).
    ``id`` is the one the push link carries (``/notificaciones?n=<id>``); a fresh uuid4 when the
    caller has none.
    """
    if delivered is None:
        delivered = push_ok > 0 or bool(ntfy_ok)
    return {
        "id": str(log_id) if log_id else str(uuid.uuid4()),
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
        "push_state": push_state if push_state in PUSH_STATES else None,
        # Explicit, not the column default: now() is the same for a whole bulk insert, which would
        # make the rows of one tick indistinguishable when ordering the history.
        "created_at": created_at.astimezone(timezone.utc).isoformat(),
    }


def _is_missing_table(exc: Exception) -> bool:
    text = str(exc)
    return "PGRST205" in text or "42P01" in text or "HTTP 404" in text


def _is_row_error(exc: Exception) -> bool:
    """The insert was refused because of the content of some row (FK, check, not-null, bad value)."""
    text = str(exc)
    return any(marker in text for marker in _ROW_ERROR_MARKERS)


def _created_at(row: Dict[str, Any]) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(str(row.get("created_at")))
    except (TypeError, ValueError):
        return None


def _is_missing_push_state(exc: Exception) -> bool:
    """The insert was refused because moodle_notification_log.push_state does not exist yet."""
    text = str(exc)
    return "push_state" in text and ("PGRST204" in text or "42703" in text)


class NotificationLog:
    """Buffered writer of the notification history. Never raises."""

    def __init__(self, supabase: Any, clock=None):
        self.supabase = supabase
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._rows: List[Dict[str, Any]] = []
        self._push_state_supported = True  # False once the server reported the column missing
        self.dropped = 0  # rows given up on since start (too old, buffer room or refused content)

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
        log_id: Optional[str] = None,
        push_ok: int = 0,
        push_total: int = 0,
        ntfy_attempted: bool = False,
        ntfy_ok: bool = False,
        push_state: Optional[str] = None,
        delivered: Optional[bool] = None,
    ) -> None:
        """Buffer one user-notification outcome (no network). Ignored without a user id or a database.

        ``log_id`` is the row id the notification was already sent with (see delivery.deliver_to_user).
        ``push_state`` and ``delivered`` come from the delivery (see ``build_row``).
        """
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
                    created_at=self._clock(), log_id=log_id,
                    push_state=push_state, delivered=delivered,
                )
            )
        except Exception as exc:  # noqa: BLE001 - the history must never break a delivery
            delivery._log_changed(_RECORD_KEY, f"[History] could not record a notification: {type(exc).__name__}")

    def flush(self) -> int:
        """Insert the buffered rows (one request per ``FLUSH_CHUNK``) and return how many were written.

        Rows that could not be written stay buffered for the next flush until they are
        ``MAX_ROW_AGE_SECONDS`` old; a missing table drops them at once, and a chunk refused for its
        content is retried row by row so only the refused rows are dropped. Never raises.
        """
        rows, self._rows = self._rows, []
        if not rows:
            return 0
        written = 0
        unwritten: List[Dict[str, Any]] = []
        failure: Optional[Exception] = None
        for start in range(0, len(rows), FLUSH_CHUNK):
            chunk = rows[start : start + FLUSH_CHUNK]
            if failure is not None:
                unwritten.extend(chunk)  # not sent: kept as they are
                continue
            try:
                self._insert(chunk)
                written += len(chunk)
            except Exception as exc:  # noqa: BLE001
                if _is_missing_table(exc):
                    delivery._log_changed(_INSERT_KEY, (
                        "[History] moodle_notification_log does not exist yet (re-run supabase_schema.sql); "
                        "notifications are not recorded until it does."
                    ))
                    return written
                if _is_row_error(exc):
                    ok, kept, failure = self._insert_row_by_row(chunk)
                    written += ok
                    unwritten.extend(kept)
                else:
                    failure = exc
                    unwritten.extend(chunk)
        if failure is None:
            delivery._log_changed(_INSERT_KEY, None)
            if not unwritten:
                delivery._log_changed(_DROP_KEY, None)
        else:
            # No row count in the text: it changes every tick and would defeat the log-once dedupe.
            delivery._log_changed(
                _INSERT_KEY, f"[History] could not record notifications (kept for a retry): {str(failure)[:200]}"
            )
        if unwritten:
            self._keep_for_retry(unwritten)
        return written

    def _insert_row_by_row(self, chunk: List[Dict[str, Any]]):
        """Insert a refused chunk one row at a time: drop the rows refused for their content.

        Returns (written, rows to keep, error). On a server-side error the row and the rest of the
        chunk are kept for the next flush and the error is returned.
        """
        written = 0
        for index, row in enumerate(chunk):
            try:
                self._insert([row])
                written += 1
            except Exception as exc:  # noqa: BLE001
                if _is_row_error(exc):
                    self.dropped += 1
                    delivery._log_changed(_DROP_KEY, (
                        "[History] a notification row was refused by the database (constraint or data "
                        f"error) and dropped: {str(exc)[:200]}"
                    ))
                    continue
                return written, chunk[index:], exc
        return written, [], None

    def _insert(self, chunk: List[Dict[str, Any]]) -> None:
        """Insert one chunk; without the push_state column (schema not re-run yet) it is left out."""
        if not self._push_state_supported:
            chunk = [{k: v for k, v in row.items() if k != "push_state"} for row in chunk]
            self.supabase.insert_notification_log(chunk)
            return
        try:
            self.supabase.insert_notification_log(chunk)
        except Exception as exc:  # noqa: BLE001
            if not _is_missing_push_state(exc):
                raise
            self._push_state_supported = False
            print("[History] moodle_notification_log.push_state does not exist yet (re-run supabase_schema.sql); "
                  "rows are written without it.")
            self._insert(chunk)

    def _keep_for_retry(self, rows: List[Dict[str, Any]]) -> None:
        """Put failed rows back in front of the buffer, dropping those too old or out of room."""
        keep = []
        dropped = 0
        try:
            now = self._clock()
        except Exception:  # noqa: BLE001 - a broken clock must not lose the rows
            now = None
        for row in rows:
            created = _created_at(row)
            if now is not None and created is not None and (now - created).total_seconds() > MAX_ROW_AGE_SECONDS:
                dropped += 1
            else:
                keep.append(row)
        merged = keep + self._rows
        overflow = len(merged) - MAX_BUFFERED_ROWS
        if overflow > 0:
            merged = merged[overflow:]
            dropped += overflow
        self._rows = merged
        if dropped:
            self.dropped += dropped
            # Stable text (the running total is in ``dropped``) so a long outage logs it once.
            delivery._log_changed(_DROP_KEY, "[History] notification rows were dropped after repeated insert failures.")

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
