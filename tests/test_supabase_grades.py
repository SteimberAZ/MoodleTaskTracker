"""Grade statistics methods of SupabaseClient (fakes only, no network)."""
import pytest

from supabase_client import GRADE_ITEM_KEYS, SupabaseClient

USER = "3f2c8a52-8d5e-4a0b-9f0e-6f3a1c2b4d5e"
ROW = {"course_id": 10, "item_id": 501, "course_name": "Fisica", "item_name": "Tarea 1", "item_type": "mod",
       "item_module": "assign", "cmid": 77, "item_instance": 9, "category_id": 31, "sort_order": 1, "report_depth": 2,
       "grade_raw": 17.0, "grade_min": 0.0, "grade_max": 20.0, "grade_formatted": "17,00",
       "percentage_formatted": "85,00 %", "weight_raw": 0.2, "graded_at": 1799950000, "notified_grade": "17.00",
       "user_id": "someone-else", "feedback": "<p>x</p>"}
COURSE_ROW = {"course_id": 10, "item_id": 500, "course_name": "Fisica", "item_type": "course", "item_instance": 31,
              "sort_order": 4, "report_depth": 2, "grade_raw": 17.0, "grade_min": 0.0, "grade_max": 100.0}


class Resp:
    def __init__(self, status=200, payload=None):
        self.status_code, self._payload, self.text = status, payload if payload is not None else [], ""

    def json(self):
        return self._payload


class FakeHttp:
    def __init__(self, status=200, rows=(), boom=False):
        self.status, self.rows, self.boom, self.calls = status, list(rows), boom, []

    def _record(self, verb, url, kw):
        self.calls.append((verb, url, kw))
        if self.boom:
            raise ConnectionError("down")

    def get(self, url, **kw):
        self._record("get", url, kw)
        offset = int(kw["params"].get("offset", "0"))
        return Resp(self.status, self.rows[offset:offset + 1000] if self.status == 200 else {"message": "x"})

    def post(self, url, **kw):
        self._record("post", url, kw)
        return Resp(self.status)

    def delete(self, url, **kw):
        self._record("delete", url, kw)
        return Resp(self.status)

    patch = post


def _client(http):
    return SupabaseClient(url="https://sb.example", key="k", http=http)


def test_upsert_sends_uniform_rows_to_the_composite_key():
    http = FakeHttp()
    assert _client(http).upsert_grade_items(USER, [ROW, COURSE_ROW]) is True
    assert len(http.calls) == 1
    verb, url, kw = http.calls[0]
    assert verb == "post"
    assert url == "https://sb.example/rest/v1/moodle_grade_items?on_conflict=user_id,course_id,item_id"
    assert kw["headers"]["Prefer"] == "resolution=merge-duplicates,return=minimal"
    rows = kw["json"]
    assert len(rows) == 2
    for row in rows:
        assert set(row) == set(GRADE_ITEM_KEYS)
        assert row["user_id"] == USER  # ROW's own 'someone-else' is overridden
        assert "feedback" not in row
        assert isinstance(row["fetched_at"], str) and row["fetched_at"]
    course = next(r for r in rows if r["item_id"] == 500)
    assert course["item_name"] is None and course["cmid"] is None and course["notified_grade"] is None


def test_upsert_keeps_one_row_per_course_item():
    http = FakeHttp()
    first, second = dict(ROW, grade_raw=17.0), dict(ROW, grade_raw=18.0)
    assert _client(http).upsert_grade_items(USER, [first, second]) is True
    rows = http.calls[0][2]["json"]
    assert len(rows) == 1 and rows[0]["grade_raw"] == 18.0


def test_upsert_failure_is_reported_not_raised():
    assert _client(FakeHttp(status=400)).upsert_grade_items(USER, [ROW]) is False
    assert _client(FakeHttp(boom=True)).upsert_grade_items(USER, [ROW]) is False


def test_upsert_without_rows_or_database_sends_nothing(monkeypatch):
    http = FakeHttp()
    assert _client(http).upsert_grade_items(USER, []) is True
    assert http.calls == []
    monkeypatch.delenv("MOODLE_DB_JWT", raising=False)
    off = FakeHttp()
    assert SupabaseClient(url="", http=off).upsert_grade_items(USER, [ROW]) is True
    assert off.calls == []


def test_fetch_reads_the_users_rows_in_pages():
    rows = [{"course_id": 10, "item_id": i, "grade_raw": None, "notified_grade": None} for i in range(1001)]
    http = FakeHttp(rows=rows)
    assert len(_client(http).fetch_grade_items(USER)) == 1001
    first_verb, first_url, first_kw = http.calls[0]
    assert first_url.endswith("/rest/v1/moodle_grade_items")
    assert first_kw["params"] == {
        "user_id": f"eq.{USER}", "select": "course_id,item_id,grade_raw,notified_grade",
        "order": "course_id.asc,item_id.asc", "limit": "1000", "offset": "0",
    }
    assert http.calls[1][2]["params"]["offset"] == "1000"


def test_fetch_raises_when_the_table_is_missing():
    with pytest.raises(RuntimeError, match="404"):
        _client(FakeHttp(status=404)).fetch_grade_items(USER)


def test_delete_items_keeps_the_fetched_ids():
    http = FakeHttp()
    assert _client(http).delete_grade_items(USER, 10, [501, 500, 501]) is True
    verb, url, kw = http.calls[0]
    assert verb == "delete" and url.endswith("/rest/v1/moodle_grade_items")
    assert kw["params"] == {"user_id": f"eq.{USER}", "course_id": "eq.10", "item_id": "not.in.(500,501)"}
    assert kw["headers"]["Prefer"] == "return=minimal"


def test_delete_items_without_keep_clears_the_course():
    http = FakeHttp()
    assert _client(http).delete_grade_items(USER, 10, []) is True
    assert http.calls[0][2]["params"] == {"user_id": f"eq.{USER}", "course_id": "eq.10"}


def test_delete_courses_keeps_the_current_ones():
    http = FakeHttp()
    client = _client(http)
    assert client.delete_grade_courses(USER, [11, 10]) is True
    assert http.calls[0][2]["params"] == {"user_id": f"eq.{USER}", "course_id": "not.in.(10,11)"}
    assert client.delete_grade_courses(USER, []) is True
    assert http.calls[1][2]["params"] == {"user_id": f"eq.{USER}"}


def test_delete_failure_returns_false():
    assert _client(FakeHttp(status=500)).delete_grade_items(USER, 10, [1]) is False
    assert _client(FakeHttp(boom=True)).delete_grade_items(USER, 10, [1]) is False
    assert _client(FakeHttp(status=500)).delete_grade_courses(USER, [1]) is False
    assert _client(FakeHttp(boom=True)).delete_grade_courses(USER, [1]) is False
