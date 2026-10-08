import pytest

import moodle_api
from moodle_api import (
    SWEEP_STATUS_MAX_CHECKS,
    SWEEP_TTL_SECONDS,
    MoodleApiClient,
    assignment_to_task,
    course_is_current,
    event_to_task,
    make_task_id,
    quiz_to_task,
)

BASE = "https://m.example"
USER_ID = "u1111111-aaaa"
NOW = 1_800_000_000
D = 86400

COURSES = [
    {"id": 10, "shortname": "FIS", "fullname": "Fisica", "visible": 1, "startdate": NOW - 30 * D, "enddate": NOW + 60 * D, "completed": False},
    {"id": 11, "shortname": "QUI", "fullname": "Quimica", "visible": 1, "startdate": 0, "enddate": 0},
    {"id": 12, "shortname": "OCU", "fullname": "Oculto", "visible": 0, "startdate": 0, "enddate": 0},
    {"id": 13, "shortname": "OLD", "fullname": "Viejo", "visible": 1, "startdate": NOW - 400 * D, "enddate": NOW - 300 * D},
]
ASSIGNMENTS = {"courses": [{"id": 10, "fullname": "Fisica", "shortname": "FIS", "assignments": [
    {"id": 9, "cmid": 77, "course": 10, "name": "Tarea 1", "duedate": NOW + 3 * D, "cutoffdate": 0, "allowsubmissionsfromdate": 0, "nosubmissions": 0, "intro": "<p>Hola</p>"},
    {"id": 21, "cmid": 88, "course": 10, "name": "Tarea sin fecha", "duedate": 0, "cutoffdate": 0, "allowsubmissionsfromdate": NOW - D, "nosubmissions": 0, "intro": ""},
]}], "warnings": []}
QUIZZES = {"quizzes": [{"id": 5, "coursemodule": 55, "course": 11, "name": "Quiz 1", "timeopen": NOW - 3600, "timeclose": 0, "intro": "<b>Q</b>"}], "warnings": []}


def timeline_event(cmid=77):  # same shape as tests/test_moodle_api.py::_event
    url = f"{BASE}/mod/assign/view.php?id={cmid}"
    return {"id": 1, "name": "Tarea 1 is due", "modulename": "assign", "instance": 9, "timesort": NOW + 3 * D,
            "timestart": NOW + 3 * D, "url": url, "course": {"id": 10, "fullname": "Fisica"},
            "action": {"actionable": True, "url": url}}


def responses(**over):
    r = {
        "core_calendar_get_action_events_by_timesort": {"events": [timeline_event()]},
        "core_enrol_get_users_courses": COURSES,
        "mod_assign_get_assignments": ASSIGNMENTS,
        "mod_quiz_get_quizzes_by_courses": QUIZZES,
        "mod_assign_get_submission_status": {"lastattempt": {"submission": {"status": "new"}}},
        "mod_quiz_get_user_attempts": {"attempts": [], "warnings": []},
        "core_course_get_courses_by_field": {"courses": []},
    }
    r.update(over)
    return r


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


def _calls(http, wsfunction):
    return [data for _, data in http.calls if data["wsfunction"] == wsfunction]


def _client(http):
    return MoodleApiClient(BASE, "tok", http=http, user_id=USER_ID, site_userid=42)


@pytest.fixture(autouse=True)
def _clear_caches():
    caches = (moodle_api._SWEEP_CACHE, moodle_api._TEACHERS_CACHE, moodle_api._ASSIGN_INSTANCE_CACHE)
    for cache in caches:
        cache.clear()
    yield
    for cache in caches:
        cache.clear()


# ---- mapping ---------------------------------------------------------------------------------


def test_swept_assignment_keeps_the_timeline_task_id():
    swept = assignment_to_task(ASSIGNMENTS["courses"][0]["assignments"][0], COURSES[0], BASE, USER_ID, NOW)
    timeline = event_to_task(timeline_event(77), BASE, user_id=USER_ID)
    assert swept["id"] == timeline["id"] == make_task_id(f"{BASE}/mod/assign/view.php?id=77", USER_ID)
    assert swept["task_url"] == f"{BASE}/mod/assign/view.php?id=77"
    assert swept["module"] == "assign" and swept["assign_id"] == 9 and swept["course_module_id"] == 77
    assert swept["course"] == "Fisica" and swept["course_id"] == 10
    assert swept["description"] == "Hola"
    assert swept["source"] == "sweep"
    assert swept["user_id"] == USER_ID


def test_swept_quiz_uses_the_quiz_view_url():
    task = quiz_to_task(QUIZZES["quizzes"][0], COURSES[1], BASE, USER_ID, NOW)
    assert task["task_url"] == f"{BASE}/mod/quiz/view.php?id=55"
    assert task["module"] == "quiz" and task["assign_id"] is None and task["quiz_id"] == 5
    assert task["due_timestamp"] == 0
    assert task["due_date_str"] == "Sin fecha límite indicada"


def _assign(**over):
    a = {"id": 9, "cmid": 77, "name": "A", "duedate": 0, "cutoffdate": 0, "nosubmissions": 0, "intro": ""}
    a.update(over)
    return assignment_to_task(a, COURSES[0], BASE, USER_ID, NOW)


def _quiz(**over):
    q = {"id": 5, "coursemodule": 55, "name": "Q", "timeopen": 0, "timeclose": 0, "intro": ""}
    q.update(over)
    return quiz_to_task(q, COURSES[1], BASE, USER_ID, NOW)


@pytest.mark.parametrize("build,expected", [
    (lambda: _assign(duedate=NOW + 3 * D), NOW + 3 * D),
    (lambda: _assign(cutoffdate=NOW + D), NOW + D),
    (lambda: _assign(), 0),
    (lambda: _assign(duedate=NOW - 8 * D), None),
    (lambda: _assign(duedate=NOW - 2 * D), NOW - 2 * D),
    (lambda: _assign(nosubmissions=1), None),
    (lambda: _assign(nosubmissions=1, duedate=NOW + D), NOW + D),
    (lambda: _quiz(timeclose=NOW - 60), None),
    (lambda: _quiz(timeclose=NOW + D), NOW + D),
    (lambda: _quiz(timeclose=0, timeopen=NOW + D), 0),
    (lambda: _assign(cmid=0), None),
    (lambda: _quiz(coursemodule=0), None),
])
def test_due_date_rules(build, expected):
    task = build()
    assert (None if task is None else task["due_timestamp"]) == expected


def test_course_is_current():
    assert course_is_current(COURSES[0], NOW) is True
    assert course_is_current(COURSES[1], NOW) is True
    assert course_is_current(COURSES[2], NOW) is False
    assert course_is_current(COURSES[3], NOW) is False
    assert course_is_current({"id": 14, "visible": 1, "completed": True}, NOW) is False
    assert course_is_current({"id": 15, "visible": 1, "startdate": NOW - 200 * D, "enddate": 0}, NOW) is False


# ---- sweep through the client ----------------------------------------------------------------


def test_fetch_tasks_merges_swept_activities_without_duplicates():
    client = _client(FakeHttp(responses()))
    tasks = client.fetch_tasks(now=NOW, delay=0)
    assert [t["course_module_id"] for t in tasks] == [77, 88, 55]
    assert len({t["id"] for t in tasks}) == 3
    timeline_task = tasks[0]
    assert timeline_task["title"] == "Tarea 1 is due" and "source" not in timeline_task
    assert client.last_sweep_complete is True


def test_course_ids_are_batched_in_one_call_per_function():
    http = FakeHttp(responses())
    _client(http).fetch_tasks(now=NOW, delay=0)
    names = [data["wsfunction"] for _, data in http.calls]
    for fn in ("core_enrol_get_users_courses", "mod_assign_get_assignments", "mod_quiz_get_quizzes_by_courses"):
        assert names.count(fn) == 1
    assert _calls(http, "core_enrol_get_users_courses")[0]["userid"] == 42
    for fn in ("mod_assign_get_assignments", "mod_quiz_get_quizzes_by_courses"):
        params = _calls(http, fn)[0]
        assert params["courseids[0]"] == 10 and params["courseids[1]"] == 11
        assert "courseids[2]" not in params  # hidden and long-finished courses are excluded
    assert "core_webservice_get_site_info" not in names


def test_site_userid_is_read_from_site_info_when_unknown():
    http = FakeHttp(responses(core_webservice_get_site_info={"userid": 7, "sitename": "X"}))
    client = MoodleApiClient(BASE, "tok", http=http, user_id=USER_ID)
    client.fetch_tasks(now=NOW, delay=0)
    assert _calls(http, "core_webservice_get_site_info")
    assert _calls(http, "core_enrol_get_users_courses")[0]["userid"] == 7
    assert client.site_userid == 7


def test_sweep_reads_status_only_for_activities_outside_the_timeline():
    def submission(d):
        return {"lastattempt": {"submission": {"status": "submitted" if d["assignid"] == 21 else "new"}}}

    def attempts(d):
        return {"attempts": [{"id": 1, "state": "finished"}]} if d["quizid"] == 5 else {"attempts": []}

    http = FakeHttp(responses(mod_assign_get_submission_status=submission, mod_quiz_get_user_attempts=attempts))
    tasks = _client(http).fetch_tasks(now=NOW, delay=0)
    # 9 is read by the timeline loop; 77 is the timeline task, so the sweep never reads it again
    assert [d["assignid"] for d in _calls(http, "mod_assign_get_submission_status")] == [9, 21]
    quiz_reads = _calls(http, "mod_quiz_get_user_attempts")
    assert [d["quizid"] for d in quiz_reads] == [5] and quiz_reads[0]["status"] == "finished"
    by_cmid = {t["course_module_id"]: t for t in tasks}
    assert by_cmid[88]["status"] == "submitted" and by_cmid[88]["status_source"] == "api"
    assert by_cmid[55]["status"] == "submitted" and by_cmid[55]["status_source"] == "api"


def test_sweep_is_cached_between_rounds():
    http = FakeHttp(responses())
    client = _client(http)
    first = client.fetch_tasks(now=NOW, delay=0)
    second = client.fetch_tasks(now=NOW + 60, delay=0)
    assert len(_calls(http, "core_enrol_get_users_courses")) == 1
    assert 88 in {t["course_module_id"] for t in first}
    assert 88 in {t["course_module_id"] for t in second}
    client.fetch_tasks(now=NOW + SWEEP_TTL_SECONDS + 1, delay=0)
    assert len(_calls(http, "core_enrol_get_users_courses")) == 2


def test_cached_sweep_tasks_are_copies():
    client = _client(FakeHttp(responses()))
    first = client.fetch_tasks(now=NOW, delay=0)
    task_88 = next(t for t in first if t["course_module_id"] == 88)
    task_88["status"] = "x"
    task_88["teachers"].append("y")
    again = client.fetch_tasks(now=NOW + 60, delay=0)
    cached = next(t for t in again if t["course_module_id"] == 88)
    assert cached["status"] == "pending"
    assert "y" not in cached["teachers"]


def _broken_enrol(r):
    r["core_enrol_get_users_courses"] = {"exception": "webservice_access_exception", "errorcode": "accessexception", "message": "no"}


def _enrol_503(r):
    r["core_enrol_get_users_courses"] = FakeResp({}, 503)


def _no_quiz_endpoint(r):
    del r["mod_quiz_get_quizzes_by_courses"]


@pytest.mark.parametrize("break_it", [_broken_enrol, _enrol_503, _no_quiz_endpoint])
def test_a_failed_sweep_falls_back_to_the_timeline(break_it):
    r = responses()
    break_it(r)
    client = _client(FakeHttp(r))
    tasks = client.fetch_tasks(now=NOW, delay=0)
    assert [t["course_module_id"] for t in tasks] == [77]
    assert client.last_sweep_complete is False


def test_a_failed_sweep_reuses_the_last_good_result():
    r = responses()
    http = FakeHttp(r)
    client = _client(http)
    client.fetch_tasks(now=NOW, delay=0)
    r["core_enrol_get_users_courses"] = FakeResp({}, 503)
    later = client.fetch_tasks(now=NOW + SWEEP_TTL_SECONDS + 1, delay=0)
    assert {t["course_module_id"] for t in later} == {77, 88, 55}
    assert client.last_sweep_complete is False
    enrol_calls = len(_calls(http, "core_enrol_get_users_courses"))
    # the retry waits for the TTL instead of hitting Moodle on every sync
    client.fetch_tasks(now=NOW + SWEEP_TTL_SECONDS + 61, delay=0)
    assert len(_calls(http, "core_enrol_get_users_courses")) == enrol_calls


def test_clients_without_user_id_never_sweep():
    http = FakeHttp(responses())
    MoodleApiClient(BASE, "tok", http=http).fetch_tasks(now=NOW, delay=0)
    names = {data["wsfunction"] for _, data in http.calls}
    assert not names & {"core_enrol_get_users_courses", "mod_assign_get_assignments", "mod_quiz_get_quizzes_by_courses"}


def _over_cap_client(n=SWEEP_STATUS_MAX_CHECKS + 5):
    """A client whose sweep holds n dated assignments. The one with the latest due date is already
    submitted, so the sweep reads it after the cap has been used up by the earlier ones."""
    assigns = [
        {"id": 100 + i, "cmid": 300 + i, "name": f"Tarea {i}", "duedate": NOW + (2 + i) * D,
         "cutoffdate": 0, "nosubmissions": 0, "intro": ""}
        for i in range(n)
    ]
    handed_in = {assigns[-1]["id"]}
    status_reads = []

    def submission(d):
        status_reads.append(int(d["assignid"]))
        status = "submitted" if int(d["assignid"]) in handed_in else "new"
        return {"lastattempt": {"submission": {"status": status}}}

    http = FakeHttp(responses(
        core_calendar_get_action_events_by_timesort={"events": []},
        mod_assign_get_assignments={"courses": [{"id": 10, "assignments": assigns}]},
        mod_quiz_get_quizzes_by_courses={"quizzes": []},
        mod_assign_get_submission_status=submission,
    ))
    return _client(http), status_reads, 300 + n - 1


def test_sweep_status_reads_rotate_so_a_task_past_the_cap_is_checked():
    client, status_reads, target = _over_cap_client()
    found_in_round = None
    for rnd in range(3):
        status_reads.clear()
        tasks = client.fetch_tasks(now=NOW + rnd * (SWEEP_TTL_SECONDS + 1), delay=0)
        assert len(status_reads) <= SWEEP_STATUS_MAX_CHECKS
        if next(t["status"] for t in tasks if t["course_module_id"] == target) == "submitted":
            found_in_round = rnd + 1
            break
    # 25 tasks with 20 reads a round: the task past the cap must be read within two rounds
    assert found_in_round is not None and found_in_round <= 2
