"""api_sync course sweep: first-sweep baseline, undated reconciliation and the site user id."""
import json
import time

import pytest

import api_sync
from storage import Storage

BASE = "https://m.example"
USER = {"id": "u1111111-aaaa", "ntfy_topic": "utm-u1", "token": "tok", "moodle_url": BASE, "site_userid": 42}


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
    def __init__(self, tasks=(), complete=True, statuses=None, exc=None, last_sweep_complete=True):
        self.tasks, self.exc = list(tasks), exc
        self.last_fetch_complete = complete
        self.last_sweep_complete = last_sweep_complete
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


def _task(tid, cmid=None, module="assign", due=None, source=None):
    due_ts = int(time.time()) + 2 * 86400 if due is None else due
    url = f"{BASE}/mod/{module}/view.php?id={cmid or 1}"
    task = {"id": tid, "title": f"T {tid}", "course": "C", "due_date_str": "x",
            "due_timestamp": due_ts, "task_url": url, "status": "pending",
            "assign_id": None, "course_module_id": cmid, "module": module, "description": f"desc {tid}",
            "teachers": ["Prof"], "user_id": USER["id"]}
    if source is not None:
        task["source"] = source
    return task


def _sync(storage, db, client, user=USER, **kw):
    kw.setdefault("process", lambda *a, **k: None)
    kw.setdefault("alert", lambda **k: True)
    return api_sync.sync_user_via_api(storage, dict(user), db, client=client, **kw)


def _recording_process(announced):
    """A milestone processor that announces every new task and records its 'new' milestone."""

    def process(tasks, storage, new_tasks=None, **kwargs):
        for t in new_tasks or []:
            announced.append(str(t["id"]))
            storage.record_milestone(str(t["id"]), "new")

    return process


def _counts(storage):
    return json.loads(storage.get_setting(api_sync.missing_setting_key(USER["id"]), "") or "{}")


# ---- first complete sweep baseline --------------------------------------------------------------


def test_the_first_complete_sweep_does_not_announce_the_backlog(tmp_path):
    s, db = _storage(tmp_path), Db()
    s.set_setting(api_sync.migration_flag_key(USER["id"]), "1")  # an existing user, already past the first sync
    announced = []
    process = _recording_process(announced)

    first = [_task("a", cmid=1), _task("s1", cmid=2, due=0, source="sweep"), _task("s2", cmid=3, source="sweep")]
    assert _sync(s, db, Client(first), process=process) == "ok"
    assert announced == ["a"]
    assert s.has_notified_milestone("s1", "new") and s.has_notified_milestone("s2", "new")
    assert s.get_setting(api_sync.sweep_baseline_key(USER["id"])) == "1"

    second = first + [_task("s3", cmid=4, source="sweep")]
    assert _sync(s, db, Client(second), process=process) == "ok"
    assert announced == ["a", "s3"]


def test_the_baseline_waits_for_a_complete_sweep(tmp_path):
    s, db = _storage(tmp_path), Db()
    s.set_setting(api_sync.migration_flag_key(USER["id"]), "1")
    swept = _task("s1", cmid=2, source="sweep")

    assert _sync(s, db, Client([_task("a", cmid=1), swept], last_sweep_complete=False)) == "ok"
    assert s.get_setting(api_sync.sweep_baseline_key(USER["id"]), "") != "1"
    assert not s.has_notified_milestone("s1", "new")
    assert api_sync.apply_sweep_baseline(s, [swept], USER["id"], Client(last_sweep_complete=False)) is False


# ---- undated tasks are reconciled only after a complete sweep -----------------------------------


def test_undated_tasks_are_reconciled_only_after_a_complete_sweep(tmp_path):
    s, db = _storage(tmp_path), Db()
    a = _task("a", cmid=1)
    undated_quiz = _task("u", cmid=9, module="quiz", due=0, source="sweep")
    assert _sync(s, db, Client([a, undated_quiz])) == "ok"

    for _ in range(3):  # no complete sweep behind the fetch: the undated quiz is never a candidate
        assert _sync(s, db, Client([a], last_sweep_complete=False)) == "ok"
    assert db.marked == []
    assert "u" not in _counts(s)

    for _ in range(api_sync.MISSING_ROUNDS):  # a complete sweep behind the fetch: now it counts
        assert _sync(s, db, Client([a], last_sweep_complete=True)) == "ok"
    assert db.marked == [(USER["id"], ["u"])]


def test_an_undated_swept_assignment_that_vanished_and_was_submitted_is_saved_as_submitted(tmp_path):
    s, db = _storage(tmp_path), Db()
    a = _task("a", cmid=1)
    undated_assign = _task("v", cmid=5, due=0, source="sweep")
    assert _sync(s, db, Client([a, undated_assign])) == "ok"

    assert _sync(s, db, Client([a], statuses={5: "submitted"}, last_sweep_complete=True)) == "ok"
    rows = {t["id"]: t for t in s.get_all_tasks(user_id=USER["id"])}
    assert rows["v"]["status"] == "submitted"


# ---- site user id -------------------------------------------------------------------------------


def test_the_client_gets_the_site_userid(tmp_path, monkeypatch):
    recorded = {}

    def factory(*args, **kwargs):
        recorded.update(kwargs)
        return Client([_task("a", cmid=1)])

    monkeypatch.setattr(api_sync, "MoodleApiClient", factory)
    api_sync.sync_user_via_api(_storage(tmp_path), dict(USER), Db(),
                               process=lambda *a, **k: None, alert=lambda **k: True)
    assert recorded["site_userid"] == 42
    assert recorded["user_id"] == USER["id"]
