"""Grade sync (grades_sync) and its api_sync hook: baseline, alerts, dedupe, cleanup and isolation."""
import pytest

import api_sync
import delivery
import grades_sync
from moodle_api import MoodleTokenInvalid
from storage import Storage

USER = {"id": "u1111111-aaaa", "ntfy_topic": "utm-u1", "token": "tok", "moodle_url": "https://m.example",
        "site_userid": 42}


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    delivery.reset_delivery_state()
    grades_sync._LOGGED.clear()
    api_sync._LAST_FETCHED.clear()
    monkeypatch.setattr(api_sync, "RECONCILE_DELAY", 0)
    yield
    delivery.reset_delivery_state()
    grades_sync._LOGGED.clear()
    api_sync._LAST_FETCHED.clear()


class NoMirror:
    is_configured = False

    def upsert_tasks(self, *a, **k):
        return True

    def upsert_milestone(self, *a, **k):
        return True

    def upsert_setting(self, *a, **k):
        return True


def _storage(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = NoMirror()
    return s


def item(cid, iid, raw=None, itype="mod", name=None, gmax=20.0, **extra):
    row = {
        "course_id": cid, "item_id": iid, "course_name": {10: "Fisica", 11: "Quimica"}.get(cid, "Curso"),
        "item_name": name or f"Tarea {iid}", "item_type": itype,
        "item_module": "assign" if itype == "mod" else None, "cmid": iid + 1000 if itype == "mod" else None,
        "item_instance": None, "category_id": 31, "sort_order": 0, "report_depth": 2, "grade_raw": raw,
        "grade_min": 0.0, "grade_max": gmax, "grade_formatted": None, "percentage_formatted": None,
        "weight_raw": 0.2, "graded_at": 1799950000 if raw is not None else None,
    }
    row.update(extra)
    return row


class Client:
    def __init__(self, courses, items, failed=(), due=True):
        self.result = {
            "courses": [{"id": c, "fullname": "x", "shortname": "x"} for c in courses],
            "items": items, "failed": list(failed), "complete": not failed,
        }
        self.due, self.fetches = due, 0

    def grades_due(self, now=None):
        return self.due

    def fetch_course_grades(self, now=None):
        self.fetches += 1
        return self.result


class Db:
    is_configured = True

    def __init__(self, stored=(), read_exc=None, upsert_ok=True):
        self.stored, self.read_exc, self.upsert_ok = list(stored), read_exc, upsert_ok
        self.reads = 0
        self.upserts, self.item_deletes, self.course_deletes = [], [], []

    def fetch_grade_items(self, user_id):
        self.reads += 1
        if self.read_exc:
            raise self.read_exc
        return [dict(r) for r in self.stored]

    def upsert_grade_items(self, user_id, rows):
        self.upserts.append([dict(r) for r in rows])
        return self.upsert_ok

    def delete_grade_items(self, user_id, course_id, keep):
        self.item_deletes.append((course_id, sorted(keep)))
        return True

    def delete_grade_courses(self, user_id, keep):
        self.course_deletes.append(sorted(keep))
        return True


def stored(cid, iid, raw, notified):
    return {"course_id": cid, "item_id": iid, "grade_raw": raw, "notified_grade": notified}


class Deliver:
    def __init__(self, result=True):
        self.result, self.calls = result, []

    def __call__(self, user, title, body, **kw):
        self.calls.append((user["id"], title, body, kw))
        return self.result


def run(storage, db, client, deliver):
    return grades_sync.sync_user_grades(storage, db, client, dict(USER), deliver=deliver)


def by_id(rows):
    return {(r["course_id"], r["item_id"]): r for r in rows}


def test_helpers_format_points_and_signature():
    assert grades_sync.format_points(17.0) == "17"
    assert grades_sync.format_points(8.5) == "8,5"
    assert grades_sync.format_points(100.0) == "100"
    assert grades_sync.format_points(66.25) == "66,25"
    assert grades_sync.format_points(0.125) == "0,13"
    assert grades_sync.format_points(None) == "-"
    assert grades_sync.grade_signature({"grade_raw": 17}) == "17.00"
    assert grades_sync.grade_signature({"grade_raw": 8.255}) == "8.26"
    assert grades_sync.grade_signature({"grade_raw": None}) is None
    row = item(10, 501, raw=17.0, name="Tarea 1")
    assert grades_sync.grade_alert_text(row, False) == ("Nueva calificación", "Te calificaron: Tarea 1 — 17/20 (Fisica)")
    assert grades_sync.grade_alert_text(row, True)[0] == "Calificación actualizada"


def test_first_fetch_baselines_every_grade_silently(tmp_path):
    st, db, deliver = _storage(tmp_path), Db(), Deliver()
    client = Client([10], {10: [item(10, 500, raw=17.0, itype="course", gmax=100.0), item(10, 501, raw=17.0),
                                item(10, 502)]})
    assert run(st, db, client, deliver) == "ok"
    assert deliver.calls == []
    rows = by_id(db.upserts[0])
    assert rows[(10, 500)]["notified_grade"] == "17.00"
    assert rows[(10, 501)]["notified_grade"] == "17.00"
    assert rows[(10, 502)]["notified_grade"] is None
    assert all(r["user_id"] == USER["id"] and isinstance(r["fetched_at"], str) for r in rows.values())


def test_a_newly_graded_item_sends_one_alert_to_the_stats_page(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 500, 17.0, "17.00"), stored(10, 502, None, None)])
    client = Client([10], {10: [item(10, 500, raw=25.0, itype="course", gmax=100.0), item(10, 502, raw=8.0)]})
    assert run(st, db, client, deliver) == "ok"
    assert len(deliver.calls) == 1
    _, title, body, kw = deliver.calls[0]
    assert title == "Nueva calificación"
    assert body == "Te calificaron: Tarea 502 — 8/20 (Fisica)"
    assert kw["url"] == "/estadisticas"
    assert kw["tag"] == "grade-10-502"
    assert kw["kind"] == "task"
    assert kw["renotify"] is True
    assert kw["retry_key"] == "grade-10-502:8.00"
    assert kw["priority"] == "default"
    rows = by_id(db.upserts[0])
    assert rows[(10, 502)]["notified_grade"] == "8.00"
    assert rows[(10, 500)]["notified_grade"] == "25.00"
    assert st.has_notified_milestone("grade:u1111111-aaaa:10:502", "8.00") is True
    # A second run over what was saved sends nothing new.
    db2, deliver2 = Db(db.upserts[0]), Deliver()
    assert run(st, db2, client, deliver2) == "ok"
    assert deliver2.calls == []


def test_a_changed_grade_sends_an_update_alert(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 501, 15.0, "15.00")])
    assert run(st, db, Client([10], {10: [item(10, 501, raw=17.0)]}), deliver) == "ok"
    assert len(deliver.calls) == 1
    assert deliver.calls[0][1] == "Calificación actualizada"
    assert by_id(db.upserts[0])[(10, 501)]["notified_grade"] == "17.00"


def test_a_new_item_in_a_known_course_alerts(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 500, None, None)])
    client = Client([10], {10: [item(10, 500), item(10, 503, raw=9.5)]})
    assert run(st, db, client, deliver) == "ok"
    assert len(deliver.calls) == 1
    assert "9,5/20" in deliver.calls[0][2]


def test_failed_delivery_stays_pending(tmp_path):
    st = _storage(tmp_path)
    rows = [stored(10, 500, None, None), stored(10, 502, None, None)]
    client = Client([10], {10: [item(10, 500), item(10, 502, raw=8.0)]})
    db = Db(rows)
    assert run(st, db, client, Deliver(False)) == "ok"
    assert by_id(db.upserts[0])[(10, 502)]["notified_grade"] is None
    assert st.has_notified_milestone("grade:u1111111-aaaa:10:502", "8.00") is False
    retry = Deliver(True)
    assert run(st, Db(rows), client, retry) == "ok"
    assert len(retry.calls) == 1


def test_exhausted_delivery_is_settled(tmp_path, monkeypatch):
    st = _storage(tmp_path)
    monkeypatch.setattr(grades_sync.delivery, "is_exhausted", lambda *a: True)
    db = Db([stored(10, 500, None, None), stored(10, 502, None, None)])
    client = Client([10], {10: [item(10, 500), item(10, 502, raw=8.0)]})
    assert run(st, db, client, Deliver(False)) == "ok"
    assert by_id(db.upserts[0])[(10, 502)]["notified_grade"] == "8.00"
    assert st.has_notified_milestone("grade:u1111111-aaaa:10:502", "8.00") is True


def test_local_key_blocks_a_resend_after_a_failed_db_write(tmp_path):
    st = _storage(tmp_path)
    rows = [stored(10, 500, None, None), stored(10, 502, None, None)]
    client = Client([10], {10: [item(10, 500), item(10, 502, raw=8.0)]})
    db1, first = Db(rows, upsert_ok=False), Deliver()
    assert run(st, db1, client, first) == "error"
    assert len(first.calls) == 1
    assert db1.item_deletes == [] and db1.course_deletes == []
    db2, second = Db(rows), Deliver()
    assert run(st, db2, client, second) == "ok"
    assert second.calls == []
    assert by_id(db2.upserts[0])[(10, 502)]["notified_grade"] == "8.00"


def test_new_course_is_baselined_while_known_courses_alert(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 500, 5.0, "5.00")])
    client = Client([10, 11], {10: [item(10, 500, raw=5.0)], 11: [item(11, 600, raw=9.0)]})
    assert run(st, db, client, deliver) == "ok"
    assert deliver.calls == []
    assert by_id(db.upserts[0])[(11, 600)]["notified_grade"] == "9.00"


def test_totals_never_alert(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 500, 17.0, "17.00")])
    client = Client([10], {10: [item(10, 500, raw=18.0, itype="category", gmax=100.0)]})
    assert run(st, db, client, deliver) == "ok"
    assert deliver.calls == []
    assert by_id(db.upserts[0])[(10, 500)]["notified_grade"] == "18.00"


def test_alerts_are_capped_per_run(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 500, None, None)])
    items = [item(10, 500)] + [item(10, 600 + i, raw=10.0) for i in range(12)]
    assert run(st, db, Client([10], {10: items}), deliver) == "ok"
    assert len(deliver.calls) == grades_sync.MAX_ALERTS_PER_RUN == 10
    rows = by_id(db.upserts[0])
    pending = [k for k, r in rows.items() if k[1] >= 600 and r["notified_grade"] is None]
    assert len(pending) == 2


def test_a_cleared_grade_resets_the_notified_grade(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 501, 17.0, "17.00")])
    assert run(st, db, Client([10], {10: [item(10, 501, raw=None)]}), deliver) == "ok"
    assert deliver.calls == []
    assert by_id(db.upserts[0])[(10, 501)]["notified_grade"] is None


def test_failed_courses_are_left_untouched(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = Db([stored(10, 500, 5.0, "5.00"), stored(11, 600, 3.0, "3.00")])
    client = Client([10, 11], {10: [item(10, 500, raw=5.0)]}, failed=[11])
    assert run(st, db, client, deliver) == "ok"
    assert all(r["course_id"] != 11 for r in db.upserts[0])
    assert db.item_deletes == [(10, [500])]
    assert db.course_deletes == [[10, 11]]


def test_stale_rows_are_deleted_after_a_successful_save(tmp_path):
    st = _storage(tmp_path)
    db = Db([stored(10, 500, 5.0, "5.00"), stored(10, 501, 6.0, "6.00"), stored(10, 777, 1.0, "1.00")])
    client = Client([10], {10: [item(10, 500, raw=5.0), item(10, 501, raw=6.0)]})
    assert run(st, db, client, Deliver()) == "ok"
    assert db.item_deletes == [(10, [500, 501])]
    assert db.course_deletes == [[10]]


def test_unreadable_store_skips_moodle_and_writes_nothing(tmp_path, capsys):
    st = _storage(tmp_path)
    db = Db(read_exc=RuntimeError("HTTP 404"))
    client = Client([10], {10: [item(10, 500, raw=5.0)]})
    assert run(st, db, client, Deliver()) == "error"
    assert run(st, db, client, Deliver()) == "error"
    assert client.fetches == 0
    assert db.upserts == []
    assert capsys.readouterr().out.count("moodle_grade_items does not exist yet") == 1


def test_not_due_does_nothing(tmp_path):
    st, db = _storage(tmp_path), Db()
    client = Client([10], {10: []}, due=False)
    assert run(st, db, client, Deliver()) == "not_due"
    assert db.reads == 0 and db.upserts == [] and client.fetches == 0


def test_without_grade_support_it_is_skipped(tmp_path):
    st = _storage(tmp_path)
    client = Client([10], {10: []})
    assert run(st, Db(), object(), Deliver()) == "skipped"

    class Plain:
        is_configured = True

    assert run(st, Plain(), client, Deliver()) == "skipped"
    off = Db()
    off.is_configured = False
    assert run(st, off, client, Deliver()) == "skipped"
    assert client.fetches == 0


def test_without_a_deliverer_grades_are_saved_silently(tmp_path):
    st = _storage(tmp_path)
    db = Db([stored(10, 500, None, None), stored(10, 502, None, None)])
    client = Client([10], {10: [item(10, 500), item(10, 502, raw=8.0)]})
    assert run(st, db, client, None) == "ok"
    assert by_id(db.upserts[0])[(10, 502)]["notified_grade"] == "8.00"


class TaskClient(Client):
    last_fetch_complete = False
    last_sweep_complete = False

    def fetch_tasks(self):
        return []


class SyncDb(Db):
    def set_user_synced(self, uid):
        return None


def _task_sync(storage, db, client, deliver):
    return api_sync.sync_user_via_api(
        storage, dict(USER), db, client=client, process=lambda *a, **k: None, alert=lambda **k: True,
        deliver=deliver,
    )


def test_task_sync_ignores_grade_failures(tmp_path):
    st = _storage(tmp_path)

    class TokenFails(TaskClient):
        def fetch_course_grades(self, now=None):
            raise MoodleTokenInvalid("Access control exception", code="accessexception")

    class DueFails(TaskClient):
        def grades_due(self, now=None):
            raise RuntimeError("boom")

    assert _task_sync(st, SyncDb(), TokenFails([10], {10: []}), Deliver()) == "ok"
    assert _task_sync(st, SyncDb(), DueFails([10], {10: []}), Deliver()) == "ok"


def test_task_sync_runs_the_grade_sync_for_users(tmp_path):
    st, deliver = _storage(tmp_path), Deliver()
    db = SyncDb([stored(10, 500, None, None), stored(10, 502, None, None)])
    client = TaskClient([10], {10: [item(10, 500), item(10, 502, raw=8.0)]})
    assert _task_sync(st, db, client, deliver) == "ok"
    assert len(db.upserts) == 1
    assert len(deliver.calls) == 1
    assert deliver.calls[0][2] == "Te calificaron: Tarea 502 — 8/20 (Fisica)"
