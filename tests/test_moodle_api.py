import hashlib

import pytest

import api_sync
from moodle_api import (
    Credentials,
    MoodleApiClient,
    MoodleApiError,
    MoodleTokenInvalid,
    event_to_task,
    parse_assign_submission_status,
    resolve_credentials,
)
from storage import Storage

BASE = "https://m.example"
ASSIGN_URL = f"{BASE}/mod/assign/view.php?id=77"


class FakeResp:
    def __init__(self, payload, status=200):
        self._p = payload
        self.status_code = status

    def json(self):
        if isinstance(self._p, Exception):
            raise self._p
        return self._p


class FakeHttp:
    """Maps wsfunction -> payload (or a callable) and records the calls."""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def post(self, url, data=None, timeout=None):
        self.calls.append((url, dict(data)))
        r = self.responses[data["wsfunction"]]
        if callable(r):
            r = r(data)
        return r if isinstance(r, FakeResp) else FakeResp(r)


def _event(**over):
    ev = {
        "id": 1,
        "name": "Tarea 1 is due",
        "modulename": "assign",
        "instance": 9,
        "timesort": 1_800_000_000,
        "timestart": 1_800_000_000,
        "url": ASSIGN_URL,
        "course": {"fullname": "Fisica", "shortname": "FIS"},
        "action": {"name": "Add submission", "actionable": True, "url": ASSIGN_URL + "&action=editsubmission"},
    }
    ev.update(over)
    return ev


# ---- mapping ---------------------------------------------------------------------------------


def test_event_to_task_maps_fields_and_keeps_legacy_id():
    t = event_to_task(_event(), BASE)
    assert t["id"] == hashlib.md5(ASSIGN_URL.encode()).hexdigest()
    assert t["title"] == "Tarea 1 is due"
    assert t["course"] == "Fisica"
    assert t["due_timestamp"] == 1_800_000_000
    assert t["task_url"] == ASSIGN_URL
    assert t["status"] == "pending"
    assert t["assign_id"] == 9
    assert t["course_module_id"] == 77
    assert t["due_date_str"].count("/") == 2


def test_event_to_task_skips_attendance():
    assert event_to_task(_event(modulename="attendance"), BASE) is None
    assert event_to_task(_event(name="Asistencia clase"), BASE) is None


def test_non_assign_event_is_done_only_when_not_actionable():
    quiz = _event(modulename="quiz", instance=3, url=f"{BASE}/mod/quiz/view.php?id=5")
    assert event_to_task(quiz, BASE)["status"] == "pending"
    assert event_to_task(quiz, BASE)["assign_id"] is None
    quiz["action"]["actionable"] = False
    assert event_to_task(quiz, BASE)["status"] == "submitted"


# ---- submission status -----------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"lastattempt": {"submission": {"status": "submitted"}}}, "submitted"),
        ({"lastattempt": {"teamsubmission": {"status": "submitted"}}}, "submitted"),
        ({"lastattempt": {"submission": {"status": "draft"}}}, "pending"),
        ({"lastattempt": {"submission": {"status": "new"}}}, "pending"),
        ({"lastattempt": {"submission": {"status": "draft"}, "teamsubmission": {"status": "submitted"}}}, "submitted"),
        ({"lastattempt": {"submissionsenabled": True}}, None),
        ({}, None),
        ([], None),
    ],
)
def test_parse_assign_submission_status(payload, expected):
    assert parse_assign_submission_status(payload) == expected


def test_fetch_tasks_resolves_assign_status_and_tags_source():
    http = FakeHttp({
        "core_calendar_get_action_events_by_timesort": {"events": [_event(), _event(id=2, instance=10, url=f"{BASE}/mod/assign/view.php?id=78")]},
        "mod_assign_get_submission_status": lambda d: {
            "lastattempt": {"submission": {"status": "submitted" if d["assignid"] == 9 else "draft"}}
        },
    })
    tasks = MoodleApiClient(BASE, "tok", http=http).fetch_tasks(now=1_700_000_000, delay=0)
    assert [t["status"] for t in tasks] == ["submitted", "pending"]
    assert all(t["status_source"] == "api" for t in tasks)
    first = http.calls[0]
    assert first[0] == f"{BASE}/webservice/rest/server.php"
    assert first[1]["wstoken"] == "tok" and first[1]["moodlewsrestformat"] == "json"
    assert first[1]["timesortfrom"] == 1_700_000_000 - 86400 and first[1]["limitnum"] == 50


def test_assign_status_failure_degrades_to_pending_but_invalidtoken_propagates():
    err = {"exception": "x", "errorcode": "nopermission", "message": "no"}
    ev = {"events": [_event()]}
    http = FakeHttp({"core_calendar_get_action_events_by_timesort": ev, "mod_assign_get_submission_status": err})
    tasks = MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)
    assert tasks[0]["status"] == "pending"

    http = FakeHttp({
        "core_calendar_get_action_events_by_timesort": ev,
        "mod_assign_get_submission_status": {"exception": "x", "errorcode": "invalidtoken", "message": "bad"},
    })
    with pytest.raises(MoodleTokenInvalid):
        MoodleApiClient(BASE, "tok", http=http).fetch_tasks(delay=0)


# ---- error detection -------------------------------------------------------------------------


@pytest.mark.parametrize("code", ["invalidtoken", "accessexception"])
def test_token_error_codes_raise_token_invalid(code):
    http = FakeHttp({"f": {"exception": "moodle_exception", "errorcode": code, "message": "nope"}})
    with pytest.raises(MoodleTokenInvalid) as ei:
        MoodleApiClient(BASE, "tok", http=http).call("f")
    assert ei.value.code == code


def test_other_errors_raise_generic_api_error():
    http = FakeHttp({"f": {"exception": "x", "errorcode": "somethingelse", "message": "m"}})
    with pytest.raises(MoodleApiError) as ei:
        MoodleApiClient(BASE, "tok", http=http).call("f")
    assert not isinstance(ei.value, MoodleTokenInvalid)


def test_http_and_json_errors_are_typed():
    with pytest.raises(MoodleApiError) as ei:
        MoodleApiClient(BASE, "t", http=FakeHttp({"f": FakeResp({}, status=503)})).call("f")
    assert ei.value.code == "http"
    with pytest.raises(MoodleApiError) as ei:
        MoodleApiClient(BASE, "t", http=FakeHttp({"f": FakeResp(ValueError("x"))})).call("f")
    assert ei.value.code == "badresponse"


# ---- token source ----------------------------------------------------------------------------


class FakeSupabase:
    is_configured = True

    def __init__(self, row=None, fail=False):
        self.row, self.fail, self.updates = row, fail, []

    def fetch_credentials(self):
        if self.fail:
            raise RuntimeError("down")
        return self.row

    def update_credentials(self, fields):
        self.updates.append(fields)
        return True


def test_token_from_supabase_row_wins_over_env():
    sb = FakeSupabase({"token": " abc ", "moodle_url": "https://row.example"})
    c = resolve_credentials(sb, env={"MOODLE_TOKEN": "env-token"})
    assert (c.token, c.base_url, c.source) == ("abc", "https://row.example", "supabase")


@pytest.mark.parametrize("sb", [FakeSupabase(None), FakeSupabase({"token": ""}), FakeSupabase(fail=True), None])
def test_token_falls_back_to_env(sb):
    c = resolve_credentials(sb, env={"MOODLE_TOKEN": "env-token", "MOODLE_URL": "https://env.example"})
    assert (c.token, c.base_url, c.source) == ("env-token", "https://env.example", "env")


def test_no_token_anywhere_returns_none():
    assert resolve_credentials(FakeSupabase(None), env={}) is None


# ---- sync + migration guard ------------------------------------------------------------------


class _NoSupabase:
    is_configured = False


def _storage(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _NoSupabase()
    return s


class StubClient:
    def __init__(self, tasks=None, exc=None):
        self.tasks, self.exc = tasks or [], exc

    def fetch_tasks(self):
        if self.exc:
            raise self.exc
        return [dict(t) for t in self.tasks]


def _task(tid="a1"):
    return {"id": tid, "title": "T", "course": "C", "due_date_str": "x", "due_timestamp": 0,
            "task_url": "u", "status": "pending"}


def test_migration_guard_suppresses_new_alerts_only_on_first_sync(tmp_path):
    s = _storage(tmp_path)
    creds = Credentials("tok", BASE, "env")
    seen = []

    def process(tasks, storage, new_tasks=None):
        # mimic the notifier: announce only tasks whose 'new' milestone is unrecorded
        seen.append([t["id"] for t in (new_tasks or []) if not storage.has_notified_milestone(t["id"], "new")])

    assert api_sync.sync_tasks_via_api(s, creds, client=StubClient([_task("a1")]), process=process, alert=lambda **k: None) == "ok"
    assert seen[-1] == []
    assert s.has_notified_milestone("a1", "new")
    # second sync: a genuinely new task is announced
    api_sync.sync_tasks_via_api(s, creds, client=StubClient([_task("a1"), _task("b2")]), process=process, alert=lambda **k: None)
    assert seen[-1] == ["b2"]


def test_invalid_token_alerts_once_and_records_error(tmp_path):
    s = _storage(tmp_path)
    sb = FakeSupabase({"token": "tok"})
    creds = Credentials("tok", BASE, "supabase")
    alerts = []
    stub = StubClient(exc=MoodleTokenInvalid("bad", code="invalidtoken"))
    for _ in range(3):
        out = api_sync.sync_tasks_via_api(s, creds, sb, client=stub, alert=lambda **k: alerts.append(k))
        assert out == "invalid"
    assert len(alerts) == 1
    assert alerts[0]["message"] == "Moodle desconectado: vuelve a conectar tu cuenta en la web"
    assert sb.updates[0]["last_error"].startswith("invalidtoken") and sb.updates[0]["last_error_at"]
    # a new token re-arms the alert
    out = api_sync.sync_tasks_via_api(
        s, Credentials("tok2", BASE, "supabase"), sb, client=stub, alert=lambda **k: alerts.append(k)
    )
    assert len(alerts) == 2


def test_recovery_clears_error_and_alert_state(tmp_path):
    s = _storage(tmp_path)
    sb = FakeSupabase()
    creds = Credentials("tok", BASE, "supabase")
    alerts = []
    api_sync.sync_tasks_via_api(s, creds, sb, client=StubClient(exc=MoodleTokenInvalid("b", code="invalidtoken")),
                                alert=lambda **k: alerts.append(k))
    out = api_sync.sync_tasks_via_api(s, creds, sb, client=StubClient([_task()]), process=lambda *a, **k: None,
                                      alert=lambda **k: alerts.append(k))
    assert out == "ok"
    assert sb.updates[-1] == {"last_error": None, "last_error_at": None}
    assert alerts[-1]["title"] == "Moodle reconectado"


def test_transient_errors_return_error_without_alert(tmp_path):
    s = _storage(tmp_path)
    alerts = []
    for exc in (MoodleApiError("down", code="network"), RuntimeError("boom")):
        out = api_sync.sync_tasks_via_api(s, Credentials("t", BASE, "env"), client=StubClient(exc=exc),
                                          alert=lambda **k: alerts.append(k))
        assert out == "error"
    assert alerts == []
