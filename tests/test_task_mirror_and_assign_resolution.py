import pytest

import api_sync
import moodle_api
import supabase_client
from moodle_api import Credentials, MoodleApiClient
from storage import Storage
from supabase_client import SupabaseClient

BASE = "https://m.example"
SB = "https://sb.example"


class _Resp:
    def __init__(self, status=201, text=""):
        self.status_code = status
        self.text = text


# ---- supabase_client: uniform rows, status handling ------------------------------------------


def _client():
    return SupabaseClient(url=SB, key="secret-key")


def test_bulk_rows_always_share_the_same_key_set(monkeypatch):
    sent = []
    monkeypatch.setattr(
        supabase_client.requests, "post",
        lambda url, json=None, headers=None, timeout=None: sent.append((url, json)) or _Resp(201),
    )
    with_ids = {"id": "a", "title": "A", "user_id": "u", "assign_id": 9, "course_module_id": 77}
    without = {"id": "b", "title": "B", "user_id": "u"}
    assert _client().upsert_tasks([with_ids, without], async_call=False) is True
    url, rows = sent[0]
    assert url == f"{SB}/rest/v1/moodle_tasks?on_conflict=id"
    assert len(rows) == 2 and set(rows[0]) == set(rows[1])
    assert rows[1]["assign_id"] is None and rows[1]["course_module_id"] is None
    assert rows[0]["assign_id"] == 9 and rows[0]["course_module_id"] == 77


def test_duplicate_ids_in_one_batch_are_collapsed(monkeypatch):
    sent = []
    monkeypatch.setattr(
        supabase_client.requests, "post",
        lambda url, json=None, headers=None, timeout=None: sent.append(json) or _Resp(201),
    )
    t = {"id": "a", "title": "A", "user_id": "u"}
    _client().upsert_tasks([t, dict(t, title="A2")], async_call=False)
    assert [r["title"] for r in sent[0]] == ["A2"]


def test_non_2xx_is_logged_truncated_and_reported_as_failure(monkeypatch, capsys):
    body = "PGRST102 " + "x" * 1000
    monkeypatch.setattr(
        supabase_client.requests, "post",
        lambda url, json=None, headers=None, timeout=None: _Resp(400, body),
    )
    t = {"id": "a", "title": "A", "user_id": "u"}
    assert _client().upsert_tasks([t], async_call=False) is False
    out = capsys.readouterr().out
    assert "upsert_tasks HTTP 400" in out and "PGRST102" in out
    assert "x" * 400 not in out  # body truncated to 300 chars
    assert "secret-key" not in out


def test_exception_is_logged_instead_of_swallowed(monkeypatch, capsys):
    def boom(url, json=None, headers=None, timeout=None):
        raise ConnectionError("connection refused")

    monkeypatch.setattr(supabase_client.requests, "post", boom)
    assert _client().upsert_milestone("t1", "new", 1, async_call=False) is False
    assert _client().upsert_setting("k", "v", async_call=False) is False
    out = capsys.readouterr().out
    assert "upsert_milestone error: ConnectionError: connection refused" in out
    assert "upsert_setting error" in out and "secret-key" not in out


def test_milestone_reports_http_failures(monkeypatch, capsys):
    monkeypatch.setattr(
        supabase_client.requests, "post",
        lambda url, json=None, headers=None, timeout=None: _Resp(409, "fk violation"),
    )
    assert _client().upsert_milestone("t1", "new", 1, async_call=False) is False
    assert "upsert_milestone HTTP 409: fk violation" in capsys.readouterr().out


# ---- storage: milestones only after the tasks upsert succeeded --------------------------------


class _Mirror:
    is_configured = True

    def __init__(self, task_results):
        self.task_results = list(task_results)
        self.milestones = []

    def upsert_tasks(self, tasks, async_call=True):
        return self.task_results.pop(0)

    def upsert_milestone(self, task_id, milestone, sent_at, async_call=True):
        self.milestones.append((task_id, milestone))

    def upsert_setting(self, key, value, async_call=True):
        return True


def _task(tid="a1"):
    return {"id": tid, "title": "T", "user_id": "u", "status": "pending"}


def test_milestones_skipped_when_tasks_upsert_fails_then_flushed_on_success(tmp_path, capsys):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _Mirror([False, True])
    s.save_tasks([_task("a1")])
    assert s.last_task_mirror_ok is False
    s.record_milestone("a1", "new")
    assert s.supabase.milestones == []
    assert s.has_notified_milestone("a1", "new")  # local state is unaffected
    assert "Skipping Supabase milestone mirror" in capsys.readouterr().out

    s.save_tasks([_task("a1")])
    assert s.last_task_mirror_ok is True
    assert s.supabase.milestones == [("a1", "new")]
    s.record_milestone("a1", "1d")
    assert s.supabase.milestones[-1] == ("a1", "1d")


def test_milestones_mirror_immediately_when_tasks_upsert_succeeds(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _Mirror([True])
    s.save_tasks([_task("a1")])
    s.record_milestone("a1", "new")
    assert s.supabase.milestones == [("a1", "new")]


class _StubClient:
    def fetch_tasks(self):
        return [_task("a1")]


def test_sync_reports_error_only_when_task_mirror_failed(tmp_path):
    creds = Credentials("tok", BASE, "env")
    kw = dict(client=_StubClient(), process=lambda *a, **k: None, alert=lambda **k: None)
    s = Storage(str(tmp_path / "ok.db"))
    s.supabase = _Mirror([True])
    assert api_sync.sync_tasks_via_api(s, creds, **kw) == "ok"

    s = Storage(str(tmp_path / "bad.db"))
    s.supabase = _Mirror([False])
    assert api_sync.sync_tasks_via_api(s, creds, **kw) == "error"


# ---- moodle_api: invalidrecord -> course module resolution ------------------------------------


@pytest.fixture(autouse=True)
def _clear_cache():
    moodle_api._ASSIGN_INSTANCE_CACHE.clear()
    yield
    moodle_api._ASSIGN_INSTANCE_CACHE.clear()


class _FakeResp:
    status_code = 200

    def __init__(self, payload):
        self._p = payload

    def json(self):
        return self._p


class _Http:
    def __init__(self, handlers):
        self.handlers = handlers
        self.calls = []

    def post(self, url, data=None, timeout=None):
        self.calls.append((data["wsfunction"], {k: v for k, v in data.items() if k != "wstoken"}))
        return _FakeResp(self.handlers[data["wsfunction"]](data))


def _err(code, message="m"):
    return {"exception": "moodle_exception", "errorcode": code, "message": message}


URL = f"{BASE}/mod/assign/view.php?id=77"


def _event(**over):
    ev = {
        "id": 1, "name": "Tarea", "modulename": "assign", "instance": 603582, "timesort": 1_800_000_000,
        "url": URL, "course": {"fullname": "Fisica"}, "action": {"actionable": True, "url": URL},
    }
    ev.update(over)
    return ev


def _handlers(status_for, cm=None, events=None):
    return {
        "core_calendar_get_action_events_by_timesort": lambda d: {"events": events or [_event()]},
        "mod_assign_get_submission_status": lambda d: status_for(d["assignid"]),
        "core_course_get_course_module": cm or (lambda d: {"cm": {"id": d["cmid"], "modname": "assign", "instance": 15}}),
    }


def _status(assignid):
    if assignid == 15:
        return {"lastattempt": {"submission": {"status": "submitted"}}}
    return _err("invalidrecord", "Can't find data record in database table assign.")


def _status_ids(http):
    return [c[1]["assignid"] for c in http.calls if c[0] == "mod_assign_get_submission_status"]


def test_invalidrecord_resolves_instance_from_cmid_retries_and_caches():
    http = _Http(_handlers(_status))
    task = MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)[0]
    assert task["status"] == "submitted" and task["status_source"] == "api"
    assert task["assign_id"] == 15  # corrected to the instance Moodle accepted
    assert [c[0] for c in http.calls].count("core_course_get_course_module") == 1
    assert _status_ids(http) == [603582, 15]
    assert moodle_api._ASSIGN_INSTANCE_CACHE == {(BASE, 77): 15}

    # next round (new client, same process): the cache goes straight to the real instance
    http2 = _Http(_handlers(_status))
    MoodleApiClient(BASE, "tok", http=http2).fetch_tasks(delay=0)
    assert [c[0] for c in http2.calls].count("core_course_get_course_module") == 0
    assert _status_ids(http2) == [15]


def test_event_without_instance_resolves_from_cmid():
    http = _Http(_handlers(_status, events=[_event(instance=None)]))
    task = MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)[0]
    assert task["status"] == "submitted" and task["assign_id"] == 15


def test_resolution_failure_leaves_status_pending_and_logs_message(capsys):
    http = _Http(_handlers(_status, cm=lambda d: _err("nopermission", "denied")))
    task = MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)[0]
    assert task["status"] == "pending" and "status_source" not in task
    assert moodle_api._ASSIGN_INSTANCE_CACHE == {}
    out = capsys.readouterr().out
    assert "assign status failed for 603582: invalidrecord: Can't find data record" in out


def test_non_assign_module_is_not_resolved():
    cm = lambda d: {"cm": {"id": d["cmid"], "modname": "quiz", "instance": 15}}  # noqa: E731
    http = _Http(_handlers(_status, cm=cm))
    task = MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)[0]
    assert task["status"] == "pending" and moodle_api._ASSIGN_INSTANCE_CACHE == {}


def test_invalidtoken_during_resolution_still_propagates():
    http = _Http(_handlers(_status, cm=lambda d: _err("invalidtoken", "bad")))
    with pytest.raises(moodle_api.MoodleTokenInvalid):
        MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)
