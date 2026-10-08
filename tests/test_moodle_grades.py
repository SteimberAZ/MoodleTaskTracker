import pytest

import moodle_api
from moodle_api import (
    STATUS_NETWORK_ERROR_LIMIT,
    SWEEP_TTL_SECONDS,
    MoodleApiClient,
    parse_grade_items,
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
GRADES_10 = {"usergrades": [{"courseid": 10, "courseidnumber": "", "userid": 42, "userfullname": "Ana Perez", "useridnumber": "", "maxdepth": 2, "gradeitems": [
    {"id": 501, "itemname": "Tarea 1 &amp; anexo", "itemtype": "mod", "itemmodule": "assign", "iteminstance": 9, "itemnumber": 0, "idnumber": "", "categoryid": 31, "outcomeid": None, "scaleid": None, "locked": False, "cmid": 77, "weightraw": 0.2, "weightformatted": "20,00 %", "graderaw": 17.0, "gradedatesubmitted": 1799900000, "gradedategraded": 1799950000, "gradehiddenbydate": False, "gradeneedsupdate": False, "gradeishidden": False, "gradeislocked": False, "gradeisoverridden": False, "gradeformatted": "17,00", "grademin": 0, "grademax": 20, "rangeformatted": "0&ndash;20", "percentageformatted": "85,00 %", "feedback": "<p>Bien</p>", "feedbackformat": 1},
    {"id": 502, "itemname": "Examen parcial", "itemtype": "mod", "itemmodule": "quiz", "iteminstance": 5, "categoryid": 31, "cmid": 55, "weightraw": 0.3, "graderaw": None, "gradedategraded": None, "gradeformatted": "-", "grademin": 0, "grademax": 30, "percentageformatted": "-", "gradeishidden": False, "gradehiddenbydate": False},
    {"id": 503, "itemname": "Proyecto final", "itemtype": "mod", "itemmodule": "assign", "iteminstance": 21, "categoryid": 31, "cmid": 88, "weightraw": 0.5, "graderaw": None, "gradedategraded": 0, "gradeformatted": "-", "grademin": 0, "grademax": 50, "percentageformatted": "-"},
    {"id": 504, "itemname": "Tarea oculta", "itemtype": "mod", "itemmodule": "assign", "categoryid": 31, "cmid": 99, "weightraw": None, "graderaw": 10.0, "gradeishidden": True, "grademin": 0, "grademax": 10},
    {"id": 505, "itemname": "Fecha oculta", "itemtype": "mod", "itemmodule": "assign", "categoryid": 31, "cmid": 98, "graderaw": 9.0, "gradehiddenbydate": True, "grademin": 0, "grademax": 10},
    {"id": 506, "itemname": "Resultado", "itemtype": "outcome", "graderaw": 1.0},
    {"id": 500, "itemname": None, "itemtype": "course", "itemmodule": None, "iteminstance": 31, "categoryid": None, "cmid": None, "weightraw": None, "graderaw": "17.00000", "gradeformatted": "17,00", "grademin": 0, "grademax": 100, "percentageformatted": "17,00 %", "gradeishidden": False},
]}], "warnings": []}
GRADES_11 = {"usergrades": [{"courseid": 11, "userid": 42, "maxdepth": 1, "gradeitems": [
    {"id": 600, "itemname": "", "itemtype": "course", "iteminstance": 41, "graderaw": None, "grademin": 0, "grademax": 100, "gradeformatted": "-"}]}], "warnings": []}
ACCESS = {"exception": "moodle_exception", "errorcode": "accessexception", "message": "Access control exception"}
INVALID = {"exception": "moodle_exception", "errorcode": "invalidtoken", "message": "Invalid token"}

GRADE_FN = "gradereport_user_get_grade_items"
ENROL_FN = "core_enrol_get_users_courses"


def _grades_by_course(data):
    return {"10": GRADES_10, "11": GRADES_11}[str(data["courseid"])]


def responses(**over):
    r = {
        ENROL_FN: COURSES,
        GRADE_FN: _grades_by_course,
        "mod_assign_get_assignments": {"courses": [], "warnings": []},
        "mod_quiz_get_quizzes_by_courses": {"quizzes": [], "warnings": []},
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


def _ids(rows):
    return [r["item_id"] for r in rows]


@pytest.fixture(autouse=True)
def _clear_caches(monkeypatch):
    monkeypatch.setattr(moodle_api.time, "sleep", lambda s: None)
    caches = (moodle_api._SWEEP_CACHE, moodle_api._TEACHERS_CACHE, moodle_api._ASSIGN_INSTANCE_CACHE,
              moodle_api._COURSES_CACHE, moodle_api._GRADES_CACHE)
    for cache in caches:
        cache.clear()
    yield
    for cache in caches:
        cache.clear()


# ---- parse_grade_items -----------------------------------------------------------------------


def test_parse_maps_every_visible_item():
    rows = parse_grade_items(GRADES_10, COURSES[0], 42)
    assert _ids(rows) == [501, 502, 503, 500]
    assert rows[0] == {
        "course_id": 10, "item_id": 501, "course_name": "Fisica", "item_name": "Tarea 1 & anexo",
        "item_type": "mod", "item_module": "assign", "cmid": 77, "item_instance": 9, "category_id": 31,
        "sort_order": 0, "report_depth": 2, "grade_raw": 17.0, "grade_min": 0.0, "grade_max": 20.0,
        "grade_formatted": "17,00", "percentage_formatted": "85,00 %", "weight_raw": 0.2,
        "graded_at": 1799950000,
    }
    by_id = {r["item_id"]: r for r in rows}
    assert by_id[503]["graded_at"] is None
    assert by_id[502]["graded_at"] is None and by_id[502]["grade_raw"] is None
    course_row = by_id[500]
    assert course_row["item_name"] is None and course_row["item_type"] == "course"
    assert course_row["grade_raw"] == 17.0 and course_row["item_instance"] == 31 and course_row["sort_order"] == 6
    assert all("feedback" not in r for r in rows)


def test_parse_never_keeps_hidden_or_unknown_items():
    ids = _ids(parse_grade_items(GRADES_10, COURSES[0], 42))
    assert 504 not in ids and 505 not in ids and 506 not in ids


def test_parse_rejects_malformed_answers():
    for bad in ({}, [], {"usergrades": "x"}, "text"):
        assert parse_grade_items(bad, COURSES[0], 42) is None
    assert parse_grade_items({"usergrades": []}, COURSES[0], 42) == []
    two_users = {"usergrades": [
        {"userid": 42, "maxdepth": 1, "gradeitems": [{"id": 1, "itemtype": "course"}]},
        {"userid": 7, "maxdepth": 1, "gradeitems": [{"id": 2, "itemtype": "course"}]},
    ]}
    assert _ids(parse_grade_items(two_users, COURSES[0], 7)) == [2]
    assert _ids(parse_grade_items(two_users, COURSES[0])) == [1]


# ---- fetch_course_grades ---------------------------------------------------------------------


def test_fetch_reads_each_current_course_once_per_ttl():
    http = FakeHttp(responses())
    client = _client(http)
    result = client.fetch_course_grades(now=NOW)
    assert [c["id"] for c in result["courses"]] == [10, 11]
    assert _ids(result["items"][10]) == [501, 502, 503, 500]
    assert _ids(result["items"][11]) == [600]
    assert result["failed"] == [] and result["complete"] is True
    calls = _calls(http, GRADE_FN)
    assert [(c["courseid"], c["userid"]) for c in calls] == [(10, 42), (11, 42)]

    assert client.fetch_course_grades(now=NOW + 60) is None
    assert client.grades_due(NOW + 60) is False
    assert len(_calls(http, GRADE_FN)) == 2

    assert client.grades_due(NOW + SWEEP_TTL_SECONDS) is True
    assert client.fetch_course_grades(now=NOW + SWEEP_TTL_SECONDS) is not None
    assert len(_calls(http, GRADE_FN)) == 4


def test_fetch_reuses_the_course_list_of_a_recent_sweep():
    http = FakeHttp(responses())
    client = _client(http)
    client.sweep_course_activities(now=NOW)
    assert client.fetch_course_grades(now=NOW + 5) is not None
    assert len(_calls(http, ENROL_FN)) == 1

def test_fetch_lists_every_enrolled_course_including_finished_ones():
    http = FakeHttp(responses())
    result = _client(http).fetch_course_grades(now=NOW)
    assert result["enrolled_ids"] == [10, 11, 12, 13]


def test_a_cached_course_list_still_reports_the_enrolled_courses():
    http = FakeHttp(responses())
    client = _client(http)
    client.sweep_course_activities(now=NOW)
    fresh = _client(http)
    assert fresh.fetch_course_grades(now=NOW + 5)["enrolled_ids"] == [10, 11, 12, 13]


def test_a_forbidden_course_only_fails_that_course():
    def grades(data):
        return ACCESS if str(data["courseid"]) == "11" else GRADES_10

    http = FakeHttp(responses(**{GRADE_FN: grades}))
    result = _client(http).fetch_course_grades(now=NOW)
    assert result["failed"] == [11] and result["complete"] is False
    assert list(result["items"]) == [10]


def test_a_rejected_token_stops_the_fetch():
    http = FakeHttp(responses(**{GRADE_FN: INVALID}))
    assert _client(http).fetch_course_grades(now=NOW) is None
    assert [c["courseid"] for c in _calls(http, GRADE_FN)] == [10]


def test_network_errors_stop_after_the_limit():
    enrol = COURSES + [{"id": 14, "fullname": "Bio", "visible": 1, "startdate": 0, "enddate": 0}]
    http = FakeHttp(responses(**{ENROL_FN: enrol, GRADE_FN: FakeResp({}, status=503)}))
    result = _client(http).fetch_course_grades(now=NOW)
    assert sorted(result["failed"]) == [10, 11, 14] and result["complete"] is False
    assert result["items"] == {}
    assert len(_calls(http, GRADE_FN)) == STATUS_NETWORK_ERROR_LIMIT == 2


def test_unreadable_course_list_waits_for_the_ttl():
    http = FakeHttp(responses(**{ENROL_FN: FakeResp({}, status=503)}))
    client = _client(http)
    assert client.fetch_course_grades(now=NOW) is None
    calls_before = len(http.calls)
    assert client.fetch_course_grades(now=NOW + 60) is None
    assert len(http.calls) == calls_before

    moodle_api._COURSES_CACHE.clear()
    moodle_api._GRADES_CACHE.clear()
    http = FakeHttp(responses(**{ENROL_FN: {"not": "a list"}}))
    assert _client(http).fetch_course_grades(now=NOW) is None
    assert _calls(http, GRADE_FN) == []


def test_a_malformed_report_fails_the_course():
    def grades(data):
        return {"usergrades": "x"} if str(data["courseid"]) == "10" else GRADES_11

    http = FakeHttp(responses(**{GRADE_FN: grades}))
    result = _client(http).fetch_course_grades(now=NOW)
    assert result["failed"] == [10] and list(result["items"]) == [11]


def test_grades_due_needs_a_user():
    http = FakeHttp(responses())
    client = MoodleApiClient(BASE, "tok", http=http)
    assert client.grades_due(NOW) is False
    assert client.fetch_course_grades(now=NOW) is None
    assert http.calls == []


def test_sweep_still_treats_a_non_list_course_answer_as_no_courses():
    http = FakeHttp(responses(**{ENROL_FN: {"x": 1}}))
    client = _client(http)
    assert client.sweep_course_activities(now=NOW) == []
    assert client.last_sweep_complete is True
