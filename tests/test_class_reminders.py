"""Class reminders from each user's imported schedule, plus the built-in schedule as a fallback."""
from datetime import datetime, timedelta, timezone

import pytest

import class_reminders
import class_schedule
import supabase_client
from class_reminders import (
    class_message,
    in_reminder_window,
    lead_label,
    process_class_reminders,
    title_case,
)
from storage import Storage
from supabase_client import SupabaseClient

EC = class_schedule.ECUADOR_TZ
U1 = "11111111-aaaa-bbbb-cccc-000000000001"
U2 = "22222222-aaaa-bbbb-cccc-000000000002"

# A Tuesday (ISO weekday 2) in Ecuador.
TUESDAY = datetime(2026, 10, 6, 0, 0, tzinfo=EC)


def at(hour, minute=0, second=0, day=TUESDAY):
    return day.replace(hour=hour, minute=minute, second=second)


# ---- fakes -------------------------------------------------------------------------------------------


class FakeStorage:
    def __init__(self):
        self.recorded = set()
        self.mirror_flags = []

    def has_notified_milestone(self, task_id, milestone):
        return (task_id, milestone) in self.recorded

    def record_milestone(self, task_id, milestone, mirror=True):
        self.recorded.add((task_id, milestone))
        self.mirror_flags.append(mirror)


class FakeDb:
    is_configured = True

    def __init__(self, users=None, classes=None, fail=False):
        self.users, self.classes, self.fail = users or [], classes or [], fail
        self.schedule_calls = []

    def fetch_class_reminder_users(self):
        if self.fail:
            raise RuntimeError("HTTP 503")
        return list(self.users)

    def fetch_class_schedule(self, user_ids, weekday):
        self.schedule_calls.append((list(user_ids), weekday))
        return [c for c in self.classes if c["user_id"] in user_ids and c["weekday"] == weekday]


class Deliverer:
    def __init__(self, result=True):
        self.result, self.calls = result, []

    def __call__(self, user, title, body, url="/", tag="moodle", priority="default", **kw):
        self.calls.append(dict(user=user["id"], title=title, body=body, url=url, tag=tag, priority=priority, **kw))
        return self.result


def _user(uid=U1, minutes=30, **over):
    u = {"id": uid, "ntfy_topic": "utm-x", "ntfy_enabled": True, "class_reminder_minutes": minutes, "is_admin": False}
    u.update(over)
    return u


def _class(cid="c1", user=U1, weekday=2, start="07:00:00", end="09:00:00", **over):
    c = {"id": cid, "user_id": user, "subject": "DESARROLLO DE APLICACIONES WEB", "parallel": "A", "weekday": weekday,
         "start_time": start, "end_time": end, "teacher": "PARRAGA VALLE JOSE EDUARDO",
         "room_code": "1-59-1-03-LC", "room_type": "LABORATORIO DE COMPUTACION", "floor": "1", "period_end": None}
    c.update(over)
    return c


def _run(db, now, deliver=None, storage=None):
    storage = storage or FakeStorage()
    deliver = deliver or Deliverer()
    return process_class_reminders(storage, db, deliver, now=now), storage, deliver


# ---- window rule -------------------------------------------------------------------------------------


@pytest.mark.parametrize("now, expected", [
    (at(6, 29, 59), False),  # one second before the 30-minute window opens
    (at(6, 30), True),  # window opens exactly at start - lead
    (at(6, 59, 59), True),  # still before the class
    (at(7, 0), False),  # at the start: too late
    (at(7, 1), False),  # after the start
])
def test_window_boundaries_for_a_30_minute_lead(now, expected):
    assert in_reminder_window(at(7), 30, now) is expected
    db = FakeDb([_user(minutes=30)], [_class()])
    sent, _, deliver = _run(db, now)
    assert (sent, len(deliver.calls)) == ((1, 1) if expected else (0, 0))


@pytest.mark.parametrize("lead, first_minute", [(30, (6, 30)), (60, (6, 0)), (180, (4, 0))])
def test_each_lead_time_opens_its_own_window(lead, first_minute):
    db = FakeDb([_user(minutes=lead)], [_class()])
    h, m = first_minute
    before = at(h, m) - timedelta(seconds=1)
    assert _run(db, before)[0] == 0
    sent, _, deliver = _run(db, at(h, m))
    assert sent == 1
    assert deliver.calls[0]["title"].startswith(f"📚 Clase en {lead_label(lead)}: ")


def test_a_late_tick_still_warns_before_the_class_starts():
    db = FakeDb([_user(minutes=60)], [_class()])
    sent, _, deliver = _run(db, at(6, 50))
    assert sent == 1
    assert deliver.calls[0]["ttl"] == 10 * 60  # until the class starts


def test_ttl_is_the_time_left_but_at_least_a_minute():
    db = FakeDb([_user(minutes=30)], [_class()])
    assert _run(db, at(6, 30))[2].calls[0]["ttl"] == 30 * 60
    assert _run(db, at(6, 59, 50))[2].calls[0]["ttl"] == 60


def test_users_with_reminders_off_or_invalid_never_get_classes_queried():
    db = FakeDb([_user(minutes=None), _user(uid=U2, minutes="abc"), _user(uid="u3", minutes=0)], [_class()])
    assert _run(db, at(6, 45))[0] == 0
    assert db.schedule_calls == []


def test_the_delivery_call_shape():
    db = FakeDb([_user()], [_class(cid="c9")])
    _, _, deliver = _run(db, at(6, 45))
    c = deliver.calls[0]
    assert (c["user"], c["url"], c["tag"], c["priority"]) == (U1, "/horario", "class-c9-2026-10-06", "high")
    assert c["ntfy_tags"] == "alarm_clock,mortarboard,books"


def test_each_user_gets_only_their_own_lead_time():
    db = FakeDb([_user(U1, 30), _user(U2, 180)], [_class("a", U1), _class("b", U2)])
    sent, _, deliver = _run(db, at(5, 0))
    assert sent == 1 and [c["user"] for c in deliver.calls] == [U2]  # 05:00 is inside 3 h but not 30 min
    sent, _, deliver = _run(db, at(6, 40))
    assert sent == 2 and sorted(c["user"] for c in deliver.calls) == [U1, U2]


# ---- weekday mapping (ISO, America/Guayaquil) ------------------------------------------------------


@pytest.mark.parametrize("utc_now, iso_weekday", [
    (datetime(2026, 10, 7, 2, 0, tzinfo=timezone.utc), 2),  # Wed 02:00 UTC is still Tue 21:00 in Guayaquil
    (datetime(2026, 10, 6, 3, 0, tzinfo=timezone.utc), 1),  # Tue 03:00 UTC is already Mon 22:00 there
    (datetime(2026, 10, 6, 5, 0, tzinfo=timezone.utc), 2),  # 05:00 UTC is midnight in Guayaquil: Tuesday starts
    (datetime(2026, 10, 12, 3, 0, tzinfo=timezone.utc), 7),  # Mon 03:00 UTC is Sun 22:00 there; Sunday is 7, not 0
])
def test_the_weekday_is_iso_in_guayaquil_not_utc(utc_now, iso_weekday):
    db = FakeDb([_user()], [])
    _run(db, utc_now)
    assert db.schedule_calls == [([U1], iso_weekday)]


def test_a_class_on_another_weekday_is_ignored():
    db = FakeDb([_user()], [_class(weekday=3)])
    assert _run(db, at(6, 45))[0] == 0


def test_a_utc_clock_reading_the_next_day_still_matches_the_local_class():
    # 02:00 UTC on Wednesday is 21:00 Tuesday in Ecuador: a Tuesday 21:30 class is inside a 30 min lead.
    db = FakeDb([_user()], [_class(start="21:30:00", end="22:30:00")])
    now = datetime(2026, 10, 7, 2, 10, tzinfo=timezone.utc)
    sent, storage, _ = _run(db, now)
    assert sent == 1 and ("class:c1:2026-10-06", "sent") in storage.recorded


# ---- period end ------------------------------------------------------------------------------------


def test_reminders_stop_after_the_period_end_but_not_on_it():
    db = FakeDb([_user()], [_class(period_end="2026-10-05")])
    assert _run(db, at(6, 45))[0] == 0  # Tuesday 6 > Monday 5
    db = FakeDb([_user()], [_class(period_end="2026-10-06")])
    assert _run(db, at(6, 45))[0] == 1  # the last day still counts
    db = FakeDb([_user()], [_class(period_end="2027-01-31T00:00:00+00:00")])
    assert _run(db, at(6, 45))[0] == 1  # timestamp-shaped values are read by their date


def test_an_unreadable_period_end_does_not_silence_the_class():
    db = FakeDb([_user()], [_class(period_end="not-a-date")])
    assert _run(db, at(6, 45))[0] == 1


# ---- dedupe and failures ---------------------------------------------------------------------------


def test_a_class_is_notified_once_per_date_and_again_next_week():
    db = FakeDb([_user()], [_class()])
    storage, deliver = FakeStorage(), Deliverer()
    assert process_class_reminders(storage, db, deliver, now=at(6, 40)) == 1
    assert process_class_reminders(storage, db, deliver, now=at(6, 41)) == 0
    assert len(deliver.calls) == 1
    assert storage.recorded == {("class:c1:2026-10-06", "sent")}
    assert storage.mirror_flags == [False]  # class keys are local only (no moodle_tasks row to mirror)

    next_week = TUESDAY + timedelta(days=7)
    assert process_class_reminders(storage, db, deliver, now=at(6, 40, day=next_week)) == 1
    assert ("class:c1:2026-10-13", "sent") in storage.recorded


def test_a_total_delivery_failure_is_not_recorded_and_retried():
    db = FakeDb([_user()], [_class()])
    storage, deliver = FakeStorage(), Deliverer(result=False)
    assert process_class_reminders(storage, db, deliver, now=at(6, 40)) == 0
    assert storage.recorded == set() and len(deliver.calls) == 1

    deliver.result = True
    assert process_class_reminders(storage, db, deliver, now=at(6, 41)) == 1
    assert storage.recorded == {("class:c1:2026-10-06", "sent")}


def test_a_crashing_deliverer_or_bad_row_does_not_stop_the_other_classes():
    db = FakeDb([_user()], [_class("bad", start="garbage"), _class("c2", start="07:10:00", end="08:00:00"),
                            _class("c3", start="07:20:00", end="08:00:00")])
    calls = []

    def deliver(user, title, body, **kw):
        calls.append(kw["tag"])
        if "c2" in kw["tag"]:
            raise RuntimeError("boom")
        return True

    storage = FakeStorage()
    assert process_class_reminders(storage, db, deliver, now=at(6, 55)) == 1
    assert calls == ["class-c2-2026-10-06", "class-c3-2026-10-06"]
    assert storage.recorded == {("class:c3:2026-10-06", "sent")}


def test_an_unreachable_database_is_logged_once_and_never_raises(capsys):
    class_reminders.delivery._last_logged.clear()
    db = FakeDb(fail=True)
    assert _run(db, at(6, 45))[0] == 0
    assert _run(db, at(6, 46))[0] == 0
    assert capsys.readouterr().out.count("could not read the class schedule") == 1
    class_reminders.delivery._last_logged.clear()


@pytest.mark.parametrize("supabase, deliver", [(None, Deliverer()), (FakeDb([_user()], [_class()]), None)])
def test_nothing_happens_without_a_database_or_a_deliverer(supabase, deliver):
    assert process_class_reminders(FakeStorage(), supabase, deliver, now=at(6, 45)) == 0


def test_an_unconfigured_database_is_skipped():
    db = FakeDb([_user()], [_class()])
    db.is_configured = False
    assert _run(db, at(6, 45))[0] == 0


# ---- message formatting ----------------------------------------------------------------------------


@pytest.mark.parametrize("raw, expected", [
    ("DESARROLLO DE APLICACIONES WEB", "Desarrollo de Aplicaciones Web"),
    ("INTRODUCCIÓN A LA INVESTIGACIÓN CIENTÍFICA (EMI)", "Introducción a la Investigación Científica (EMI)"),
    ("CÁLCULO DIFERENCIAL Y INTEGRAL II", "Cálculo Diferencial y Integral II"),
    ("DE LA TORRE JUAN", "De la Torre Juan"),  # the first word is always capitalized
    ("FÍSICA III (LAB)", "Física III (LAB)"),
    ("ADMINISTRACIÓN DEL TIEMPO EN LOS NEGOCIOS", "Administración del Tiempo en los Negocios"),
    ("ARQUITECTURA PRE-PROFESIONAL", "Arquitectura Pre-Profesional"),
    ("  RIVADENEIRA   BARREIRO  LUCIA ", "Rivadeneira Barreiro Lucia"),
    ("", ""),
    (None, ""),
])
def test_title_case_rules(raw, expected):
    assert title_case(raw) == expected


@pytest.mark.parametrize("minutes, label", [(30, "30 min"), (60, "1 hora"), (180, "3 horas"), (120, "2 horas"), (45, "45 min")])
def test_lead_labels(minutes, label):
    assert lead_label(minutes) == label


def test_a_complete_message():
    title, body = class_message(_class(), 30)
    assert title == "📚 Clase en 30 min: Desarrollo de Aplicaciones Web (A)"
    assert body.split("\n") == [
        "🕘 07:00–09:00",
        "📍 Laboratorio de Computacion 1-59-1-03-LC, piso 1",
        "👨‍🏫 Parraga Valle Jose Eduardo",
    ]


def test_missing_parts_are_left_out():
    title, body = class_message(_class(parallel=None, teacher=None, room_type=None, floor=None), 60)
    assert title == "📚 Clase en 1 hora: Desarrollo de Aplicaciones Web"
    assert body.split("\n") == ["🕘 07:00–09:00", "📍 1-59-1-03-LC"]

    _, body = class_message(_class(room_code="", room_type="", floor="3", teacher="—"), 180)
    assert body.split("\n") == ["🕘 07:00–09:00", "📍 piso 3"]


def test_the_place_is_used_only_when_there_is_no_room_data():
    row = _class(room_code=None, room_type=None, floor=None, place="EDIFICIO CENTRAL", teacher=None)
    assert class_message(row, 30)[1].split("\n") == ["🕘 07:00–09:00", "📍 Edificio Central"]


def test_a_bare_row_still_produces_a_message():
    title, body = class_message({"id": "x", "start_time": "07:00", "end_time": "08:00"}, 30)
    assert title == "📚 Clase en 30 min: Clase" and body == "🕘 07:00–08:00"


# ---- built-in schedule is only a fallback -----------------------------------------------------------

# A Tuesday, 06:40 in Ecuador: DESARROLLO DE APLICACIONES WEB (built-in) starts at 07:00.
MOMENT = datetime(2026, 10, 6, 6, 40, tzinfo=EC)
ADMINS = [{"id": "adm1", "ntfy_topic": "utm-adm1", "ntfy_enabled": True},
          {"id": "adm2", "ntfy_topic": "utm-adm2", "ntfy_enabled": True}]
LEGACY_KEY = ("class_desarrollo_web_mar_2026-10-06", "30m")


class LegacyDb:
    is_configured = True

    def __init__(self, admins, with_rows=(), lookup_fails=False):
        self.admins, self.with_rows, self.lookup_fails = admins, set(with_rows), lookup_fails

    def fetch_admin_users(self):
        return list(self.admins)

    def fetch_users_with_schedule(self, user_ids):
        if self.lookup_fails:
            raise RuntimeError("HTTP 503")
        return {i for i in user_ids if i in self.with_rows}


@pytest.fixture
def legacy_clock(monkeypatch):
    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return MOMENT

    monkeypatch.setattr(class_schedule, "datetime", Frozen)
    sent = []
    monkeypatch.setattr(class_schedule, "send_class_notification", lambda c, minutes_left=30: sent.append(c["id"]))
    return sent


def _legacy(db, deliver):
    storage = FakeStorage()
    class_schedule.check_and_notify_upcoming_classes(storage, supabase=db, deliver=deliver)
    return storage


def test_the_built_in_schedule_goes_to_admins_without_an_imported_one(legacy_clock):
    deliver = Deliverer()
    storage = _legacy(LegacyDb(ADMINS), deliver)
    assert [c["user"] for c in deliver.calls] == ["adm1", "adm2"]
    assert deliver.calls[0]["title"].startswith("Proxima clase en 20 min: ")
    assert storage.recorded == {LEGACY_KEY}


def test_an_admin_with_an_imported_schedule_never_gets_the_built_in_one(legacy_clock):
    deliver = Deliverer()
    storage = _legacy(LegacyDb(ADMINS, with_rows={"adm1"}), deliver)
    assert [c["user"] for c in deliver.calls] == ["adm2"]  # only the admin without rows
    assert storage.recorded == {LEGACY_KEY}


def test_when_every_admin_imported_a_schedule_the_built_in_one_is_silent(legacy_clock):
    deliver = Deliverer()
    storage = _legacy(LegacyDb(ADMINS, with_rows={"adm1", "adm2"}), deliver)
    assert deliver.calls == [] and legacy_clock == []  # neither the admins nor the env topic
    assert storage.recorded == {LEGACY_KEY}  # handled: not re-evaluated every tick of the window


def test_the_built_in_schedule_is_kept_when_the_lookup_fails(legacy_clock):
    deliver = Deliverer()
    storage = _legacy(LegacyDb(ADMINS, with_rows={"adm1"}, lookup_fails=True), deliver)
    assert [c["user"] for c in deliver.calls] == ["adm1", "adm2"]
    assert storage.recorded == {LEGACY_KEY}


def test_the_env_topic_fallback_is_unchanged(legacy_clock):
    _legacy(LegacyDb([]), Deliverer())
    assert legacy_clock == ["desarrollo_web_mar"]


# ---- Supabase REST shapes ----------------------------------------------------------------------------


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code, self._payload, self.text = status, payload if payload is not None else [], text

    def json(self):
        return self._payload


def _client():
    return SupabaseClient(url="https://sb.example", key="k")


def test_fetch_class_reminder_users_query(monkeypatch):
    seen = []

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.append({"url": url, "params": params})
        return _Resp(200, [{"id": U1, "class_reminder_minutes": 60}, "junk", {"ntfy_topic": "x"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    assert [u["id"] for u in _client().fetch_class_reminder_users()] == [U1]
    assert seen == [{"url": "https://sb.example/rest/v1/moodle_users", "params": {
        "active": "eq.true", "class_reminder_minutes": "not.is.null",
        "select": "id,ntfy_topic,class_reminder_minutes,is_admin,ntfy_confirmed_at,ntfy_enabled"}}]


def test_fetch_class_reminder_users_raises_when_the_column_is_missing(monkeypatch):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(400, text="column class_reminder_minutes"))
    with pytest.raises(RuntimeError):
        _client().fetch_class_reminder_users()


def test_fetch_class_schedule_query_and_chunking(monkeypatch):
    seen = []

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.append((url, params))
        return _Resp(200, [{"id": f"c{len(seen)}", "user_id": "u"}, {"no_id": 1}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    ids = [f"u{i}" for i in range(120)]
    rows = _client().fetch_class_schedule(ids + ["u0", ""], 3)
    assert [r["id"] for r in rows] == ["c1", "c2", "c3"]
    assert [len(p["user_id"].split(",")) for _, p in seen] == [50, 50, 20]
    assert seen[0][0] == "https://sb.example/rest/v1/moodle_class_schedule"
    assert seen[0][1]["weekday"] == "eq.3" and seen[0][1]["select"] == "*"
    assert seen[0][1]["user_id"].startswith("in.(u0,u1,") and seen[0][1]["user_id"].endswith(")")


def test_fetch_class_schedule_without_ids_makes_no_request(monkeypatch):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: pytest.fail("no request expected"))
    assert _client().fetch_class_schedule([], 2) == []


def test_fetch_users_with_schedule_collects_distinct_ids(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(params=params)
        return _Resp(200, [{"user_id": U1}, {"user_id": U1}, {"user_id": U2}, "junk"])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    assert _client().fetch_users_with_schedule([U1, U2, "u3"]) == {U1, U2}
    assert seen["params"] == {"user_id": f"in.({U1},{U2},u3)", "select": "user_id"}


@pytest.mark.parametrize("call", [
    lambda c: c.fetch_class_schedule(["u"], 1),
    lambda c: c.fetch_users_with_schedule(["u"]),
])
def test_schedule_reads_raise_on_http_errors(monkeypatch, call):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(503))
    with pytest.raises(RuntimeError):
        call(_client())


def test_unconfigured_client_reads_nothing():
    c = SupabaseClient(url="", key="")
    assert c.fetch_class_reminder_users() == []
    assert c.fetch_class_schedule(["u"], 1) == []
    assert c.fetch_users_with_schedule(["u"]) == set()


# ---- Storage -----------------------------------------------------------------------------------------


class _Mirror:
    is_configured = True

    def __init__(self):
        self.milestones = []

    def upsert_milestone(self, task_id, milestone, sent_at, async_call=True):
        self.milestones.append((task_id, milestone))
        return True


def test_local_only_milestones_are_not_mirrored(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _Mirror()
    s.record_milestone("class:c1:2026-10-06", "sent", mirror=False)
    assert s.has_notified_milestone("class:c1:2026-10-06", "sent")
    assert s.supabase.milestones == []
    s.record_milestone("t1", "new")  # the default still mirrors
    assert s.supabase.milestones == [("t1", "new")]
