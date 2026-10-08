"""Task details (description, course, module, teachers) and tasks muted from the web."""
import time

import pytest

import moodle_api
import notifier
import supabase_client
from api_sync import sync_user_via_api
from moodle_api import MoodleApiClient, MoodleApiError, event_to_task, html_to_text, make_task_id
from storage import Storage
from supabase_client import SupabaseClient

BASE = "https://details.example"
SB = "https://sb.example"
URL_A = f"{BASE}/mod/quiz/view.php?id=11"
URL_B = f"{BASE}/mod/quiz/view.php?id=22"
USER = {"id": "33333333-aaaa-bbbb-cccc-000000000003", "moodle_url": BASE, "token": "tok",
        "ntfy_topic": "utm-cccccccccccc", "last_error": None}


@pytest.fixture(autouse=True)
def _clean_teachers_cache():
    moodle_api._TEACHERS_CACHE.clear()
    yield
    moodle_api._TEACHERS_CACHE.clear()


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p


class FakeHttp:
    """wsfunction -> payload | callable | Exception; records every call."""

    def __init__(self, responses):
        self.responses, self.calls = responses, []

    def post(self, url, data=None, timeout=None):
        self.calls.append(dict(data))
        r = self.responses[data["wsfunction"]]
        if callable(r):
            r = r(data)
        if isinstance(r, Exception):
            raise r
        return FakeResp(r)

    def count(self, wsfunction):
        return sum(1 for c in self.calls if c["wsfunction"] == wsfunction)


def _courses(*names):
    return {"courses": [{"id": 5, "contacts": [{"id": i, "fullname": n} for i, n in enumerate(names)]}]}


def _event(url=URL_A, course_id=5, hours=5, **over):
    ev = {
        "id": 1, "name": "Cuestionario", "modulename": "quiz", "instance": 3,
        "timesort": int(time.time()) + hours * 3600, "url": url,
        "description": "<p>Hola&nbsp;<b>mundo</b></p>",
        "course": {"id": course_id, "fullname": "Fisica"},
        "action": {"actionable": True, "url": url},
    }
    ev.update(over)
    return ev


# ---- description / mapping ---------------------------------------------------------------------


def test_html_to_text_strips_tags_unescapes_and_collapses_whitespace():
    raw = "<div><p>Entrega   el\n informe</p><script>alert(1)</script><style>p{}</style>" \
          "<p>A &amp; B &lt;ok&gt; caf&eacute;&nbsp;listo</p></div>"
    assert html_to_text(raw) == "Entrega el informe A & B <ok> café listo"
    assert html_to_text(None) == "" and html_to_text("") == ""


def test_html_to_text_caps_the_length():
    assert len(html_to_text("<p>" + "x" * 10_000 + "</p>")) == 4000


def test_event_to_task_carries_module_course_id_and_plain_description():
    t = event_to_task(_event(), BASE, user_id="u")
    assert (t["module"], t["course_id"]) == ("quiz", 5)
    assert t["description"] == "Hola mundo"
    no_course = event_to_task(_event(course={"fullname": "X"}), BASE)
    assert no_course["course_id"] is None


# ---- teachers ------------------------------------------------------------------------------------


def test_teachers_are_parsed_in_order_and_deduplicated():
    http = FakeHttp({"core_course_get_courses_by_field": _courses("Ana Perez", "Luis  Mora", "Ana Perez", "")})
    teachers = MoodleApiClient(BASE, "tok", http=http).fetch_course_teachers(5)
    assert teachers == ["Ana Perez", "Luis Mora"]
    call = http.calls[0]
    assert (call["field"], call["value"]) == ("id", 5)


def test_teachers_are_cached_per_course_with_a_ttl(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(moodle_api, "_now", lambda: clock[0])
    http = FakeHttp({"core_course_get_courses_by_field": _courses("Ana")})
    client = MoodleApiClient(BASE, "tok", http=http)
    assert client.fetch_course_teachers(5) == ["Ana"]
    assert client.fetch_course_teachers(5) == ["Ana"]
    assert MoodleApiClient(BASE, "other-token", http=http).fetch_course_teachers(5) == ["Ana"]  # shared cache
    assert http.count("core_course_get_courses_by_field") == 1
    client.fetch_course_teachers(6)  # another course: its own call
    assert http.count("core_course_get_courses_by_field") == 2
    clock[0] += moodle_api.TEACHERS_TTL + 1
    client.fetch_course_teachers(5)
    assert http.count("core_course_get_courses_by_field") == 3


@pytest.mark.parametrize("failure", [
    MoodleApiError("denied", code="accessexception"),
    {"exception": "x", "errorcode": "invalidparameter", "message": "bad"},
    ValueError("boom"),
])
def test_teacher_error_yields_empty_list_and_one_log_line(failure, capsys):
    http = FakeHttp({"core_course_get_courses_by_field": failure})
    client = MoodleApiClient(BASE, "tok", http=http)
    assert client.fetch_course_teachers(5) == []
    assert client.fetch_course_teachers(5) == []  # short negative cache: no hammering
    out = capsys.readouterr().out
    assert out.count("could not read teachers of course 5") == 1
    assert http.count("core_course_get_courses_by_field") == 1


def test_stale_teachers_survive_a_failed_refresh(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(moodle_api, "_now", lambda: clock[0])
    state = {"fail": False}

    def respond(data):
        return MoodleApiError("down", code="network") if state["fail"] else _courses("Ana")

    client = MoodleApiClient(BASE, "tok", http=FakeHttp({"core_course_get_courses_by_field": respond}))
    assert client.fetch_course_teachers(5) == ["Ana"]
    clock[0] += moodle_api.TEACHERS_TTL + 1
    state["fail"] = True
    assert client.fetch_course_teachers(5) == ["Ana"]


def test_fetch_tasks_attaches_details_with_one_teacher_call_per_course():
    http = FakeHttp({
        "core_calendar_get_action_events_by_timesort": {"events": [
            _event(URL_A), _event(URL_B, id=2), _event(f"{BASE}/mod/quiz/view.php?id=33", course_id=9, id=3),
        ]},
        "core_course_get_courses_by_field": lambda d: _courses("Ana") if d["value"] == 5 else _courses("Luis"),
    })
    tasks = MoodleApiClient(BASE, "tok", http=http, user_id="u").fetch_tasks(delay=0)
    assert http.count("core_course_get_courses_by_field") == 2
    assert [t["teachers"] for t in tasks] == [["Ana"], ["Ana"], ["Luis"]]
    assert all(t["details_updated_at"].endswith("+00:00") for t in tasks)
    assert tasks[0]["description"] == "Hola mundo" and tasks[0]["course_id"] == 5


def test_teacher_failure_never_breaks_fetch_tasks():
    http = FakeHttp({
        "core_calendar_get_action_events_by_timesort": {"events": [_event()]},
        "core_course_get_courses_by_field": MoodleApiError("nope", code="accessexception"),
    })
    tasks = MoodleApiClient(BASE, "tok", http=http, user_id="u").fetch_tasks(delay=0)
    assert len(tasks) == 1 and tasks[0]["teachers"] == []


# ---- supabase payload / reads --------------------------------------------------------------------


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code, self._payload, self.text = status, payload, text

    def json(self):
        return self._payload


def test_upsert_payload_omits_is_dismissed_and_keeps_uniform_keys(monkeypatch):
    sent = []
    monkeypatch.setattr(
        supabase_client.requests, "post",
        lambda url, json=None, headers=None, timeout=None: sent.append(json) or _Resp(201),
    )
    full = {"id": "a", "title": "A", "user_id": "u", "is_dismissed": 1, "description": "d", "course_id": 5,
            "module": "quiz", "teachers": ["Ana"], "details_updated_at": "2026-01-01T00:00:00+00:00"}
    bare = {"id": "b", "title": "B", "user_id": "u"}
    assert SupabaseClient(url=SB, key="k").upsert_tasks([full, bare], async_call=False) is True
    rows = sent[0]
    assert all("is_dismissed" not in r for r in rows)
    assert set(rows[0]) == set(rows[1])
    assert {"description", "course_id", "module", "teachers", "details_updated_at"} <= set(rows[0])
    assert rows[0]["teachers"] == ["Ana"] and rows[0]["course_id"] == 5
    assert rows[1]["teachers"] == [] and rows[1]["description"] is None  # teachers is NOT NULL in the DB


def test_fetch_muted_task_ids_queries_the_users_dismissed_rows(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params)
        return _Resp(200, [{"id": "t1"}, {"id": "t2"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    assert SupabaseClient(url=SB, key="k").fetch_muted_task_ids("uid-1") == {"t1", "t2"}
    assert seen["url"] == f"{SB}/rest/v1/moodle_tasks"
    assert seen["params"] == {"user_id": "eq.uid-1", "is_dismissed": "eq.1", "select": "id"}


def test_fetch_muted_task_ids_raises_on_http_errors(monkeypatch):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(503))
    with pytest.raises(RuntimeError, match="HTTP 503"):
        SupabaseClient(url=SB, key="k").fetch_muted_task_ids("uid-1")


# ---- notifications respect web mutes -------------------------------------------------------------


class Mirror:
    """Stands in for both the worker's Supabase client and Storage's mirror."""

    is_configured = True

    def __init__(self, muted=None, fail=False):
        self.muted, self.fail = muted or set(), fail
        self.upserted, self.updates = [], []

    def fetch_muted_task_ids(self, user_id):
        if self.fail:
            raise RuntimeError("HTTP 503")
        return set(self.muted)

    def upsert_tasks(self, tasks, async_call=True):
        self.upserted.extend(dict(t) for t in tasks)
        return True

    def upsert_milestone(self, *a, **k):
        return True

    def upsert_setting(self, *a, **k):
        return True

    def update_user(self, user_id, fields):
        self.updates.append((user_id, fields))
        return True


class EventClient:
    def __init__(self, events):
        self.events = events

    def fetch_tasks(self):
        return [event_to_task(e, BASE, user_id=USER["id"]) for e in self.events]


@pytest.fixture
def pushes(monkeypatch):
    sent = []
    monkeypatch.setattr(notifier, "send_whatsapp_alert", lambda **k: sent.append((k.get("topic"), k.get("title"))))
    monkeypatch.setattr(notifier, "send_windows_notification", lambda **k: None)
    return sent


def _storage(tmp_path, mirror):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = mirror
    return s


def _events():
    return [_event(URL_A, name="Muted task"), _event(URL_B, name="Loud task", id=2)]


def test_muted_tasks_get_no_notifications_and_the_flag_is_mirrored_locally(tmp_path, pushes):
    muted_id = make_task_id(URL_A, USER["id"])
    mirror = Mirror(muted={muted_id})
    s = _storage(tmp_path, mirror)

    out = sync_user_via_api(s, USER, mirror, client=EventClient(_events()), alert=lambda **k: None)

    assert out == "ok"
    assert pushes == [(USER["ntfy_topic"], "Loud task")]  # only the unmuted task reaches ntfy (8h milestone)
    with s._get_conn() as conn:
        flags = {r["id"]: r["is_dismissed"] for r in conn.execute("SELECT id, is_dismissed FROM tasks")}
    assert flags == {muted_id: 1, make_task_id(URL_B, USER["id"]): 0}
    assert len(mirror.upserted) == 2  # muted tasks are still synced


def test_unmuting_on_the_web_clears_the_local_flag(tmp_path, pushes):
    muted_id = make_task_id(URL_A, USER["id"])
    mirror = Mirror(muted={muted_id})
    s = _storage(tmp_path, mirror)
    sync_user_via_api(s, USER, mirror, client=EventClient(_events()), alert=lambda **k: None)
    mirror.muted = set()
    sync_user_via_api(s, USER, mirror, client=EventClient(_events()), alert=lambda **k: None)
    with s._get_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM tasks WHERE is_dismissed = 1").fetchone()[0] == 0


def test_muted_fetch_failure_skips_notifications_but_still_upserts_tasks(tmp_path, pushes, capsys):
    mirror = Mirror(fail=True)
    s = _storage(tmp_path, mirror)

    out = sync_user_via_api(s, USER, mirror, client=EventClient(_events()), alert=lambda **k: None)

    assert out == "ok"
    assert pushes == []
    assert len(mirror.upserted) == 2
    log = capsys.readouterr().out
    assert "could not read muted tasks" in log and "notifications skipped" in log


def test_without_supabase_notifications_proceed_as_before(tmp_path, pushes):
    class NoSupabase:
        is_configured = False

    s = _storage(tmp_path, NoSupabase())
    out = sync_user_via_api(s, USER, NoSupabase(), client=EventClient(_events()), alert=lambda **k: None)
    assert out == "ok"
    assert sorted(t for _, t in pushes) == ["Loud task", "Muted task"]


# ---- the 'new' alert is retried until it gets through ----------------------------------------------


def _new_alert_titles(calls):
    return [c["body"] for c in calls if c["title"] == "Nueva tarea en Moodle UTM"]


def _first_then_far_task(tmp_path, mirror):
    """Storage after a first (guarded) sync of task A; returns it and the events with a far-off task B."""
    s = _storage(tmp_path, mirror)
    first = [_event(URL_A, name="Old task", hours=200)]
    sync_user_via_api(s, USER, mirror, client=EventClient(first), alert=lambda **k: None,
                      deliver=lambda *a, **k: True)
    return s, first + [_event(URL_B, name="Far task", id=2, hours=200)]  # > 72 h: only 'new' applies


def test_a_failed_new_task_alert_is_retried_on_the_next_sync(tmp_path):
    mirror = Mirror()
    s, events = _first_then_far_task(tmp_path, mirror)
    calls, ok = [], {"value": False}

    def deliver(user, **k):
        calls.append(k)
        return ok["value"]

    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    assert len(_new_alert_titles(calls)) == 1  # tried, nothing got through
    assert not s.has_notified_milestone(make_task_id(URL_B, USER["id"]), "new")

    ok["value"] = True
    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    new = _new_alert_titles(calls)
    assert len(new) == 2 and "Far task" in new[-1]
    assert s.has_notified_milestone(make_task_id(URL_B, USER["id"]), "new")

    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    assert len(_new_alert_titles(calls)) == 2  # announced once, never again


def test_a_new_task_found_while_mutes_are_unreadable_is_announced_once_they_are(tmp_path):
    mirror = Mirror()
    s, events = _first_then_far_task(tmp_path, mirror)
    calls = []

    def deliver(user, **k):
        calls.append(k)
        return True

    mirror.fail = True
    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    assert calls == []

    mirror.fail = False
    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    new = _new_alert_titles(calls)
    assert len(new) == 1 and "Far task" in new[0]


def test_a_task_muted_when_found_is_not_announced_as_new_after_unmuting(tmp_path):
    mirror = Mirror()
    s, events = _first_then_far_task(tmp_path, mirror)
    calls = []

    def deliver(user, **k):
        calls.append(k)
        return True

    mirror.muted = {make_task_id(URL_B, USER["id"])}
    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    mirror.muted = set()
    sync_user_via_api(s, USER, mirror, client=EventClient(events), alert=lambda **k: None, deliver=deliver)
    assert _new_alert_titles(calls) == []
