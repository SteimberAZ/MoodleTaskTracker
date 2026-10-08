"""api_sync robustness: circuit breaker, rejected-token skip, cached alerts and reconciliation."""
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

import api_sync
from moodle_api import MoodleApiError, MoodleNetworkError, MoodleTokenInvalid
from storage import Storage

BASE = "https://m.example"
USER = {"id": "u1111111-aaaa", "ntfy_topic": "utm-u1", "token": "tok", "moodle_url": BASE}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    api_sync._LAST_FETCHED.clear()
    monkeypatch.setattr(api_sync, "RECONCILE_DELAY", 0)
    yield
    api_sync._LAST_FETCHED.clear()


class Mirror:
    """Storage-side Supabase stand-in that records task upserts."""

    is_configured = True

    def __init__(self):
        self.upserts = []

    def upsert_tasks(self, tasks, async_call=True):
        self.upserts.append([dict(t) for t in tasks])
        return True

    def upsert_milestone(self, *a, **k):
        return True

    def upsert_setting(self, *a, **k):
        return True


class Db:
    """The worker's Supabase client stand-in (the optional C4 methods are switched per test)."""

    is_configured = True

    def __init__(self, mark_result=True, with_mark=True, with_synced=True):
        self.updates, self.marked, self.synced = [], [], []
        self._mark_result = mark_result
        self.muted = set()
        if not with_mark:
            self.mark_tasks_missing = None
        if not with_synced:
            self.set_user_synced = None

    def update_user(self, user_id, fields):
        self.updates.append(fields)
        return True

    def fetch_muted_task_ids(self, user_id):
        return set(self.muted)

    def mark_tasks_missing(self, user_id, ids):
        self.marked.append((user_id, list(ids)))
        return self._mark_result

    def set_user_synced(self, user_id):
        self.synced.append(user_id)


class Client:
    def __init__(self, tasks=(), complete=True, statuses=None, exc=None):
        self.tasks, self.exc = list(tasks), exc
        self.last_fetch_complete = complete
        self.statuses = statuses or {}
        self.status_calls = []
        self.fetches = 0

    def fetch_tasks(self):
        self.fetches += 1
        if self.exc:
            raise self.exc
        return [dict(t) for t in self.tasks]

    def _assign_status(self, assign_id, cmid):
        self.status_calls.append((assign_id, cmid))
        result = self.statuses.get(cmid)
        if isinstance(result, Exception):
            raise result
        return result, assign_id or 900 + cmid


def _storage(tmp_path, mirror=None):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = mirror or Mirror()
    return s


def _task(tid, cmid=None, module="assign", due_in=2 * 86400, **over):
    url = f"{BASE}/mod/{module}/view.php?id={cmid or 1}"
    task = {"id": tid, "title": f"T {tid}", "course": "C", "due_date_str": "x",
            "due_timestamp": int(time.time()) + due_in, "task_url": url, "status": "pending",
            "assign_id": None, "course_module_id": cmid, "module": module, "description": f"desc {tid}",
            "teachers": ["Prof"], "user_id": USER["id"]}
    task.update(over)
    return task


def _sync(storage, db, client, user=USER, **kw):
    kw.setdefault("process", lambda *a, **k: None)
    kw.setdefault("alert", lambda **k: True)
    return api_sync.sync_user_via_api(storage, dict(user), db, client=client, **kw)


def _counts(storage):
    return json.loads(storage.get_setting(api_sync.missing_setting_key(USER["id"]), "") or "{}")


# ---- circuit breaker ----------------------------------------------------------------------------


def test_the_breaker_trips_after_three_network_errors_in_a_row():
    b = api_sync.CircuitBreaker()
    for _ in range(2):
        b.record_network_error()
    assert not b.tripped
    b.record_reachable()
    for _ in range(3):
        b.record_network_error()
    assert b.tripped


@pytest.mark.parametrize("exc,failures", [
    (MoodleNetworkError("down", code="network"), 1),
    (MoodleApiError("HTTP 404", code="http", status=404), 0),
    (MoodleTokenInvalid("bad", code="invalidtoken"), 0),
])
def test_only_network_errors_feed_the_breaker(tmp_path, exc, failures):
    breaker = api_sync.CircuitBreaker()
    breaker.failures = 0 if failures else 2
    _sync(_storage(tmp_path), Db(), Client(exc=exc), breaker=breaker)
    assert breaker.failures == failures


def test_a_successful_fetch_resets_the_breaker(tmp_path):
    breaker = api_sync.CircuitBreaker()
    breaker.failures = 2
    assert _sync(_storage(tmp_path), Db(), Client([_task("a")]), breaker=breaker) == "ok"
    assert breaker.failures == 0


# ---- rejected token: skip until a new login ---------------------------------------------------------


def _iso(dt):
    return dt.isoformat()


NOW = datetime.now(timezone.utc)
REJECTED = dict(USER, last_error="invalidtoken: Token no válido", last_error_at=_iso(NOW),
                last_login_at=_iso(NOW - timedelta(hours=2)))


def test_a_user_whose_token_was_rejected_is_not_sent_to_moodle_until_a_new_login(tmp_path):
    s, client = _storage(tmp_path), Client([_task("a")])
    assert _sync(s, Db(), client, user=REJECTED) == "invalid"
    assert client.fetches == 0

    relogged = dict(REJECTED, last_login_at=_iso(NOW + timedelta(minutes=1)))
    assert _sync(s, Db(), client, user=relogged) == "ok"
    assert client.fetches == 1


@pytest.mark.parametrize("over", [
    {"last_error": "network: down"},
    {"last_login_at": None},
    {"last_error_at": "not a date"},
])
def test_other_errors_or_unknown_timestamps_never_skip(tmp_path, over):
    client = Client([_task("a")])
    _sync(_storage(tmp_path), Db(), client, user=dict(REJECTED, **over))
    assert client.fetches == 1


def test_token_rejected_since_login_understands_supabase_timestamps():
    user = {"last_error": "accessexception: x", "last_error_at": "2026-10-08T10:00:00.123456+00:00",
            "last_login_at": "2026-10-08T09:59:00Z"}
    assert api_sync.token_rejected_since_login(user)
    assert not api_sync.token_rejected_since_login(dict(user, last_login_at="2026-10-08T10:00:01Z"))


def test_a_skipped_user_still_retries_an_undelivered_disconnect_alert(tmp_path):
    s, alerts = _storage(tmp_path), []

    def alert(**k):
        alerts.append(k["title"])
        return len(alerts) > 1  # the first attempt does not get through

    for _ in range(3):
        _sync(s, Db(), Client(), user=REJECTED, alert=alert)
    assert alerts == ["Moodle desconectado", "Moodle desconectado"]


# ---- cached-task fallback ---------------------------------------------------------------------------


class Deliverer:
    def __init__(self):
        self.calls = []

    def __call__(self, user, title, body, **kw):
        self.calls.append({"title": title, "body": body, **kw})
        return True


def test_cached_tasks_get_the_8h_alert_once_over_two_invalid_rounds(tmp_path):
    s = _storage(tmp_path)
    soon = _task("t8", cmid=5, due_in=4 * 3600)
    s.save_tasks([soon])
    s.record_milestone("t8", "new")
    deliver = Deliverer()
    bad = Client(exc=MoodleTokenInvalid("bad", code="invalidtoken"))

    # round 1: Moodle rejects the token
    assert api_sync.sync_user_via_api(s, dict(USER), Db(), client=bad, deliver=deliver) == "invalid"
    # round 2: the row now carries the error and no login happened since -> skipped, no Moodle call
    assert api_sync.sync_user_via_api(s, dict(REJECTED), Db(), client=bad, deliver=deliver) == "invalid"

    tasks = [c for c in deliver.calls if c.get("kind") == "task"]
    status = [c for c in deliver.calls if c.get("kind") == "status"]
    assert len(tasks) == 1 and tasks[0]["tag"] == "task-t8"
    assert tasks[0]["body"].endswith(api_sync.CACHED_STATUS_NOTE)
    assert [c["title"] for c in status] == ["Moodle desconectado"]
    assert s.has_notified_milestone("t8", "8h")


def test_cached_alerts_skip_submitted_and_need_a_deliverer(tmp_path):
    s = _storage(tmp_path)
    s.save_tasks([_task("done", status="submitted", due_in=3600)])
    deliver = Deliverer()
    bad = Client(exc=MoodleTokenInvalid("bad", code="invalidtoken"))
    api_sync.sync_user_via_api(s, dict(USER), Db(), client=bad, deliver=deliver)
    assert [c for c in deliver.calls if c.get("kind") == "task"] == []
    # without a deliverer (ntfy-only path) the cache is never used
    seen = []
    api_sync.sync_user_via_api(s, dict(USER), Db(), client=bad, alert=lambda **k: True,
                               process=lambda *a, **k: seen.append(1))
    assert seen == []


# ---- reconciliation ---------------------------------------------------------------------------------


def test_a_vanished_submitted_assignment_becomes_submitted_and_keeps_its_details(tmp_path):
    mirror = Mirror()
    s, db = _storage(tmp_path, mirror), Db()
    a, b = _task("a", cmid=77), _task("b", cmid=78)
    assert _sync(s, db, Client([a, b])) == "ok"

    client = Client([b], statuses={77: "submitted"})
    assert _sync(s, db, client) == "ok"
    assert client.status_calls == [(None, 77)]
    rows = {t["id"]: t for t in s.get_all_tasks(user_id=USER["id"])}
    assert rows["a"]["status"] == "submitted" and rows["b"]["status"] == "pending"
    saved = mirror.upserts[-1]
    assert [t["id"] for t in saved] == ["a"]
    assert saved[0]["description"] == "desc a" and saved[0]["teachers"] == ["Prof"]
    assert saved[0]["assign_id"] == 977
    assert db.marked == [] and _counts(s) == {}


def test_a_truncated_fetch_reconciles_nothing(tmp_path):
    s, db = _storage(tmp_path), Db()
    _sync(s, db, Client([_task("a", cmid=77), _task("q", module="quiz")]))
    for _ in range(3):
        client = Client([], complete=False, statuses={77: "submitted"})
        _sync(s, db, client)
        assert client.status_calls == []
    assert db.marked == [] and _counts(s) == {}
    assert {t["status"] for t in s.get_all_tasks(user_id=USER["id"])} == {"pending"}


def test_a_client_without_completeness_info_reconciles_nothing(tmp_path):
    s, db = _storage(tmp_path), Db()
    _sync(s, db, Client([_task("q", module="quiz")]))
    client = Client([])
    del client.last_fetch_complete
    _sync(s, db, client)
    assert _counts(s) == {} and db.marked == []


def test_a_missing_task_is_flagged_after_two_absent_rounds_and_a_reappearance_clears_it(tmp_path):
    s, db = _storage(tmp_path), Db()
    quiz, other = _task("q", module="quiz"), _task("o", module="quiz")
    _sync(s, db, Client([quiz, other]))

    _sync(s, db, Client([other]))
    assert _counts(s) == {"q": 1} and db.marked == []
    _sync(s, db, Client([other]))
    assert _counts(s) == {"q": 2} and db.marked == [(USER["id"], ["q"])]
    _sync(s, db, Client([other]))
    assert db.marked == [(USER["id"], ["q"])]  # flagged once, not every round

    _sync(s, db, Client([quiz, other]))
    assert _counts(s) == {}


def test_tasks_flagged_after_an_empty_fetch_are_resent_when_they_come_back(tmp_path):
    mirror = Mirror()
    s, db = _storage(tmp_path, mirror), Db()
    quiz = _task("q", module="quiz")
    _sync(s, db, Client([quiz]))
    for _ in range(2):  # a complete fetch with no task at all, e.g. a course-visibility glitch
        _sync(s, db, Client([]))
    assert db.marked == [(USER["id"], ["q"])]
    mirror.upserts.clear()
    _sync(s, db, Client([quiz]))  # back, unchanged
    assert any(t["id"] == "q" for batch in mirror.upserts for t in batch)  # re-sent: missing_since cleared


def test_a_pending_vanished_assignment_is_rechecked_until_flagged(tmp_path):
    s, db = _storage(tmp_path), Db()
    _sync(s, db, Client([_task("a", cmid=77)]))
    calls = 0
    for _ in range(3):
        client = Client([], statuses={77: "pending"})
        _sync(s, db, client)
        calls += len(client.status_calls)
    assert calls == 2  # re-checked in the two absent rounds, then left alone
    assert db.marked == [(USER["id"], ["a"])]


def test_a_failed_flag_is_retried_on_the_next_round(tmp_path):
    s, db = _storage(tmp_path), Db(mark_result=False)
    _sync(s, db, Client([_task("q", module="quiz")]))
    for _ in range(3):
        _sync(s, db, Client([]))
    assert db.marked == [(USER["id"], ["q"])] * 2
    assert _counts(s) == {"q": 1}


def test_missing_rows_are_only_counted_without_the_data_layer_method(tmp_path):
    s, db = _storage(tmp_path), Db(with_mark=False)
    _sync(s, db, Client([_task("q", module="quiz")]))
    for _ in range(2):
        _sync(s, db, Client([]))
    assert _counts(s) == {"q": 2}


def test_a_moodle_error_during_the_recheck_applies_nothing(tmp_path):
    s, db = _storage(tmp_path), Db()
    _sync(s, db, Client([_task("a", cmid=77), _task("q", module="quiz")]))
    client = Client([], statuses={77: MoodleNetworkError("down", code="network")})
    assert _sync(s, db, client) == "ok"
    assert _counts(s) == {} and db.marked == []


def test_a_deleted_assignment_is_flagged_like_any_vanished_task(tmp_path):
    s, db = _storage(tmp_path), Db()
    _sync(s, db, Client([_task("a", cmid=77), _task("q", module="quiz")]))
    for _ in range(2):
        client = Client([], statuses={77: MoodleApiError("gone", code="invalidrecord")})
        assert _sync(s, db, client) == "ok"
    assert db.marked == [(USER["id"], ["a", "q"])]


def test_old_submitted_and_muted_rows_are_not_candidates(tmp_path):
    s, db = _storage(tmp_path), Db()
    rows = [_task("old", module="quiz", due_in=-8 * 86400), _task("sub", module="quiz", status="submitted"),
            _task("mut", module="quiz")]
    _sync(s, db, Client(rows))
    db.muted = {"mut"}
    _sync(s, db, Client([]))
    assert _counts(s) == {}


def test_a_new_assignment_url_without_previous_details_is_rechecked_by_its_module_id(tmp_path):
    s, db = _storage(tmp_path), Db()
    s.save_tasks([_task("a", cmid=81)])  # known locally, never fetched by this process
    client = Client([_task("b", cmid=82)], statuses={81: "submitted"})
    _sync(s, db, client)
    assert client.status_calls == [(None, 81)]
    assert {t["id"]: t["status"] for t in s.get_all_tasks(user_id=USER["id"])}["a"] == "submitted"


# ---- last_synced_at ---------------------------------------------------------------------------------


def test_a_clean_sync_records_the_sync_time(tmp_path):
    db = Db()
    assert _sync(_storage(tmp_path), db, Client([_task("a")])) == "ok"
    assert db.synced == [USER["id"]]


def test_no_sync_time_when_the_mirror_failed_or_the_fetch_failed(tmp_path):
    class FailingMirror(Mirror):
        def upsert_tasks(self, tasks, async_call=True):
            return False

    db = Db()
    assert _sync(_storage(tmp_path, FailingMirror()), db, Client([_task("a")])) == "error"
    assert _sync(_storage(tmp_path), db, Client(exc=MoodleNetworkError("x", code="network"))) == "error"
    assert db.synced == []


def test_the_sync_time_is_optional(tmp_path):
    assert _sync(_storage(tmp_path), Db(with_synced=False), Client([_task("a")])) == "ok"
