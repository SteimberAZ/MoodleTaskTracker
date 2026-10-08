"""pkg-worker-data: the PostgREST client (contract C4)."""
from datetime import datetime

import pytest

import supabase_client
from supabase_client import SupabaseClient

SB = "https://sb.example"
MISSING = '{{"code":"PGRST204","message":"Could not find the \'{col}\' column of \'{table}\' in the schema cache"}}'


class _Resp:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload if payload is not None else []
        self.text = text

    def json(self):
        return self._payload


def _client():
    return SupabaseClient(url=SB, key="k")


def _boom(*a, **k):
    raise ConnectionError("down")


# ---- transport -------------------------------------------------------------------------------------


def test_the_shared_session_retries_idempotent_reads_only():
    adapter = supabase_client._SESSION.get_adapter("https://sb.example/rest/v1/x")
    retry = adapter.max_retries
    assert retry.total == 2 and retry.backoff_factor == 0.5
    assert set(retry.status_forcelist) == {502, 503, 504}
    assert set(retry.allowed_methods) == {"GET"}
    assert retry.raise_on_status is False


def test_calls_use_the_session_unless_requests_is_patched(monkeypatch):
    assert supabase_client._transport("get") == supabase_client._SESSION.get
    fake = lambda *a, **k: _Resp(200, [])  # noqa: E731
    monkeypatch.setattr(supabase_client.requests, "get", fake)
    assert supabase_client._transport("get") is fake


def test_an_injected_http_object_receives_every_call():
    class Http:
        def __init__(self):
            self.calls = []

        def get(self, url, **kw):
            self.calls.append(("get", url))
            return _Resp(200, [{"id": "u1", "last_login_at": None, "token": "secret"}])

    http = Http()
    rows = SupabaseClient(url=SB, key="k", http=http).fetch_login_markers()
    assert http.calls == [("get", f"{SB}/rest/v1/moodle_users")]
    assert rows == [{"id": "u1", "last_login_at": None}]


def test_bulk_writes_get_a_longer_timeout(monkeypatch):
    seen = []
    monkeypatch.setattr(supabase_client.requests, "post",
                        lambda url, json=None, headers=None, timeout=None: seen.append(timeout) or _Resp(201))
    _client().upsert_tasks([{"id": "a", "title": "A", "user_id": "u"}], async_call=False)
    _client().upsert_setting("k", "v", async_call=False)
    assert seen == [15, 5]


# ---- milestones ------------------------------------------------------------------------------------


def test_upsert_milestone_never_overwrites_sent_at(monkeypatch):
    seen = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen.update(url=url, json=json, prefer=headers["Prefer"])
        return _Resp(201)

    monkeypatch.setattr(supabase_client.requests, "post", fake_post)
    c = _client()
    assert c.upsert_milestone("t1", "1d", 123, async_call=False) is True
    assert seen == {"url": f"{SB}/rest/v1/moodle_task_milestones?on_conflict=task_id,milestone",
                    "json": {"task_id": "t1", "milestone": "1d", "sent_at": 123},
                    "prefer": "resolution=ignore-duplicates,return=minimal"}
    assert c._headers()["Prefer"] == "resolution=merge-duplicates"  # shared headers unchanged


def test_delete_milestones_filters_task_and_keys_and_never_raises(monkeypatch):
    seen = {}
    monkeypatch.setattr(supabase_client.requests, "delete",
                        lambda url, params=None, headers=None, timeout=None: seen.update(url=url, params=params) or _Resp(204))
    assert _client().delete_milestones("t1", ["1d", "2d", "1d"]) is True
    assert seen == {"url": f"{SB}/rest/v1/moodle_task_milestones",
                    "params": {"task_id": "eq.t1", "milestone": "in.(1d,2d)"}}
    monkeypatch.setattr(supabase_client.requests, "delete", lambda *a, **k: _Resp(500, text="x"))
    assert _client().delete_milestones("t1", ["1d"]) is False
    monkeypatch.setattr(supabase_client.requests, "delete", _boom)
    assert _client().delete_milestones("t1", ["1d"]) is False
    assert _client().delete_milestones("t1", []) is True  # nothing to delete, no request


def test_fetch_milestones_since_pages_until_an_empty_page(monkeypatch):
    calls = []
    pages = [[{"task_id": "t1", "milestone": "new", "sent_at": 1}, {"task_id": "", "milestone": "x"}],
             [{"task_id": "t2", "milestone": "1d", "sent_at": 2}], []]

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append(params)
        return _Resp(200, pages[len(calls) - 1])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    rows = _client().fetch_milestones_since(14)
    assert [r["task_id"] for r in rows] == ["t1", "t2"]
    assert [c["offset"] for c in calls] == ["0", "2", "3"]
    assert calls[0]["select"] == "task_id,milestone,sent_at"
    assert calls[0]["or"].startswith("(sent_at.gte.") and calls[0]["or"].endswith(",milestone.eq.new)")
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(500))
    with pytest.raises(RuntimeError):
        _client().fetch_milestones_since(14)


def test_fetch_settings_like_uses_a_prefix_filter(monkeypatch):
    seen = []
    monkeypatch.setattr(supabase_client.requests, "get",
                        lambda url, params=None, headers=None, timeout=None: seen.append((url, params))
                        or _Resp(200, [] if len(seen) > 1 else [{"key": "api_migration_done:u1", "value": "1"}]))
    assert _client().fetch_settings_like("api_migration_done") == [{"key": "api_migration_done:u1", "value": "1"}]
    assert seen[0][0] == f"{SB}/rest/v1/moodle_settings"
    assert seen[0][1]["key"] == "like.api_migration_done*" and seen[0][1]["select"] == "key,value"


# ---- tasks -----------------------------------------------------------------------------------------


def test_task_rows_leave_the_stored_bookkeeping_columns_alone():
    row = SupabaseClient._task_row({"id": "a", "title": "A", "user_id": "u", "first_seen": 5, "is_notified": 1})
    assert not {"first_seen", "last_updated", "is_notified", "is_dismissed", "missing_since"} & set(row)
    assert SupabaseClient._task_row({"id": "a", "title": "A", "user_id": "u"}, True)["missing_since"] is None


def test_the_unscoped_fetch_tasks_is_gone():
    assert not hasattr(SupabaseClient, "fetch_tasks")


def test_upsert_tasks_clears_missing_since_and_drops_it_once_rejected(monkeypatch, capsys):
    sent = []

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append(json)
        if "missing_since" in json[0]:
            return _Resp(400, text=MISSING.format(col="missing_since", table="moodle_tasks"))
        return _Resp(201)

    monkeypatch.setattr(supabase_client.requests, "post", fake_post)
    c = _client()
    tasks = [{"id": "a", "title": "A", "user_id": "u"}, {"id": "b", "title": "B", "user_id": "u"}]
    assert c.upsert_tasks(tasks, async_call=False) is True
    assert len(sent) == 2 and "missing_since" in sent[0][0] and "missing_since" not in sent[1][0]
    assert set(sent[1][0]) == set(sent[1][1])
    assert c.missing_since_supported is False
    assert c.upsert_tasks(tasks, async_call=False) is True
    assert len(sent) == 3 and "missing_since" not in sent[2][0]  # never sent again
    assert capsys.readouterr().out.count("moodle_tasks.missing_since does not exist yet") == 1


def test_mark_tasks_missing_patches_only_unflagged_rows(monkeypatch):
    seen = []
    monkeypatch.setattr(supabase_client.requests, "patch",
                        lambda url, params=None, json=None, headers=None, timeout=None:
                        seen.append((url, params, json)) or _Resp(204))
    c = _client()
    assert c.mark_tasks_missing("u1", [f"t{i}" for i in range(60)]) is True
    assert len(seen) == 2  # chunked
    url, params, body = seen[0]
    assert url == f"{SB}/rest/v1/moodle_tasks"
    assert params["user_id"] == "eq.u1" and params["missing_since"] == "is.null"
    assert params["id"].startswith("in.(t0,t1,") and list(body) == ["missing_since"]
    assert c.mark_tasks_missing("u1", []) is True

    monkeypatch.setattr(supabase_client.requests, "patch",
                        lambda *a, **k: _Resp(400, text=MISSING.format(col="missing_since", table="moodle_tasks")))
    assert c.mark_tasks_missing("u1", ["t1"]) is None
    monkeypatch.setattr(supabase_client.requests, "patch", lambda *a, **k: pytest.fail("no request expected"))
    assert c.mark_tasks_missing("u1", ["t1"]) is None  # unsupported: a no-op


# ---- users -----------------------------------------------------------------------------------------


def test_fetch_login_markers_selects_no_token(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(params=params)
        return _Resp(200, [{"id": "u1", "last_login_at": "2026-10-01T00:00:00+00:00"}, {"last_login_at": None}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    assert _client().fetch_login_markers() == [{"id": "u1", "last_login_at": "2026-10-01T00:00:00+00:00"}]
    assert seen["params"] == {"active": "eq.true", "token": "not.is.null", "select": "id,last_login_at"}
    assert "token" not in seen["params"]["select"]
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(503))
    with pytest.raises(RuntimeError):
        _client().fetch_login_markers()


def test_fetch_users_by_ids_is_chunked_and_selects_the_optional_columns(monkeypatch):
    seen = []
    monkeypatch.setattr(supabase_client.requests, "get",
                        lambda url, params=None, headers=None, timeout=None:
                        seen.append(params) or _Resp(200, [{"id": f"u{len(seen)}"}, {"no": "id"}]))
    rows = _client().fetch_users_by_ids([f"u{i}" for i in range(70)])
    assert [r["id"] for r in rows] == ["u1", "u2"]
    assert [len(p["id"].split(",")) for p in seen] == [50, 20]
    assert seen[0]["select"].endswith(",ntfy_confirmed_at,last_synced_at,ntfy_enabled")
    assert _client().fetch_users_by_ids([]) == []


def test_a_rejected_optional_user_column_is_dropped_and_remembered(monkeypatch, capsys):
    selects = []

    def fake_get(url, params=None, headers=None, timeout=None):
        selects.append(params["select"])
        if "ntfy_confirmed_at" in params["select"]:
            return _Resp(400, text='{"code":"42703","message":"column moodle_users.ntfy_confirmed_at does not exist"}')
        return _Resp(200, [{"id": "adm1"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    c = _client()
    assert [u["id"] for u in c.fetch_admin_users()] == ["adm1"]
    assert selects == ["id,ntfy_topic,ntfy_confirmed_at,ntfy_enabled", "id,ntfy_topic,ntfy_enabled"]
    assert c.ntfy_confirmed_at_supported is False and c.column_supported("moodle_users", "ntfy_enabled")
    c.fetch_class_reminder_users()
    assert selects[-1] == "id,ntfy_topic,class_reminder_minutes,is_admin,ntfy_enabled" and len(selects) == 3
    assert capsys.readouterr().out.count("ntfy_confirmed_at does not exist yet") == 1


def test_a_column_named_only_in_the_hint_is_not_switched_off(monkeypatch):
    selects = []

    def fake_get(url, params=None, headers=None, timeout=None):
        selects.append(params["select"])
        if "last_synced_at" in params["select"]:
            return _Resp(400, text='{"code":"42703","message":"column moodle_users.last_synced_at does not exist",'
                                   '"hint":"Perhaps you meant to reference the column \\"moodle_users.ntfy_confirmed_at\\"."}')
        return _Resp(200, [{"id": "u1", "token": "t"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    c = _client()
    assert [u["id"] for u in c.fetch_active_users()] == ["u1"]
    assert c.last_synced_at_supported is False
    assert c.ntfy_confirmed_at_supported is True
    assert len(selects) == 2


def test_set_user_synced_stamps_last_synced_at(monkeypatch):
    seen = {}
    monkeypatch.setattr(supabase_client.requests, "patch",
                        lambda url, params=None, json=None, headers=None, timeout=None:
                        seen.update(url=url, params=params, json=json) or _Resp(204))
    c = _client()
    assert c.set_user_synced("u1") is True
    assert seen["url"] == f"{SB}/rest/v1/moodle_users" and seen["params"] == {"id": "eq.u1"}
    assert list(seen["json"]) == ["last_synced_at"]
    datetime.fromisoformat(seen["json"]["last_synced_at"])
    monkeypatch.setattr(supabase_client.requests, "patch",
                        lambda *a, **k: _Resp(400, text=MISSING.format(col="last_synced_at", table="moodle_users")))
    assert c.set_user_synced("u1") is None
    assert c.last_synced_at_supported is False
    monkeypatch.setattr(supabase_client.requests, "patch", _boom)
    assert c.set_user_synced("u1") is None  # unsupported: no request at all


# ---- custom reminders ------------------------------------------------------------------------------


def test_due_reminders_inner_join_active_owners_and_embed_the_task(monkeypatch):
    seen = {}
    monkeypatch.setattr(supabase_client.requests, "get",
                        lambda url, params=None, headers=None, timeout=None: seen.update(params=params)
                        or _Resp(200, [{"id": "r1", "task": {"status": "submitted", "is_dismissed": 0}}]))
    rows = _client().fetch_due_reminders("2026-01-01T00:00:00+00:00")
    assert rows == [{"id": "r1", "task": {"status": "submitted", "is_dismissed": 0}}]
    assert seen["params"]["moodle_users.active"] == "eq.true"
    assert "moodle_users!inner(" in seen["params"]["select"]


def test_due_reminders_drop_the_task_embed_when_the_relationship_is_missing(monkeypatch):
    selects = []

    def fake_get(url, params=None, headers=None, timeout=None):
        selects.append(params["select"])
        if "task:moodle_tasks" in params["select"]:
            return _Resp(400, text='{"code":"PGRST200","message":"Could not find a relationship between '
                                   '\'moodle_custom_reminders\' and \'moodle_tasks\' in the schema cache"}')
        return _Resp(200, [{"id": "r1"}])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    c = _client()
    assert c.fetch_due_reminders("2026-01-01T00:00:00+00:00") == [{"id": "r1", "task": None}]
    assert len(selects) == 2 and "task:" not in selects[1]
    c.fetch_due_reminders("2026-01-01T00:00:00+00:00")
    assert len(selects) == 3 and "task:" not in selects[2]


def _patcher(monkeypatch, response):
    seen = {}

    def fake_patch(url, params=None, json=None, headers=None, timeout=None):
        seen.update(params=params, json=json, prefer=headers["Prefer"])
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(supabase_client.requests, "patch", fake_patch)
    return seen


@pytest.mark.parametrize("response, expected", [
    (_Resp(200, [{"id": "r1"}]), True),  # exactly one row updated
    (_Resp(200, []), None),  # the conditional matched no row (lost race)
    (_Resp(500, text="boom"), False),
    (ConnectionError("down"), False),
], ids=["updated", "lost-race", "http-error", "transport-error"])
def test_conditional_update_reminder(monkeypatch, response, expected):
    seen = _patcher(monkeypatch, response)
    when = "2026-10-08T12:00:00+00:00"
    assert _client().update_reminder("r1", {"next_fire_at": "x"}, expected_next_fire_at=when) is expected
    assert seen["params"] == {"id": "eq.r1", "next_fire_at": f"eq.{when}"}
    assert seen["prefer"] == "return=representation"


def test_update_reminder_without_expectation_behaves_as_before(monkeypatch):
    seen = _patcher(monkeypatch, _Resp(204))
    assert _client().update_reminder("r1", {"active": False}) is True
    assert seen["params"] == {"id": "eq.r1"} and seen["prefer"] == "return=minimal"
    _patcher(monkeypatch, _Resp(500))
    assert _client().update_reminder("r1", {"active": False}) is False


# ---- Web Push --------------------------------------------------------------------------------------


def test_fetch_push_subscriptions_reads_the_newest_ten_with_health_fields(monkeypatch):
    seen = {}
    monkeypatch.setattr(supabase_client.requests, "get",
                        lambda url, params=None, headers=None, timeout=None: seen.update(params=params) or _Resp(200, []))
    _client().fetch_push_subscriptions("u1")
    p = seen["params"]
    assert p["limit"] == "10" and p["order"] == "updated_at.desc"
    assert {"created_at", "last_success_at", "failure_count", "last_failure_at"} <= set(p["select"].split(","))


@pytest.mark.parametrize("read", [
    lambda c: c.fetch_push_subscriptions("u1"),
    lambda c: c.fetch_push_test_requests(),
], ids=["subscriptions", "test-requests"])
def test_push_reads_raise_on_http_and_transport_errors(monkeypatch, read):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(500))
    with pytest.raises(RuntimeError, match="HTTP 500"):
        read(_client())
    monkeypatch.setattr(supabase_client.requests, "get", _boom)
    with pytest.raises(ConnectionError):
        read(_client())


def test_push_writes_return_false_and_never_raise(monkeypatch):
    for verb in ("patch", "delete"):
        monkeypatch.setattr(supabase_client.requests, verb, _boom)
    assert _client().update_push_subscription("s1", {"failure_count": 1}) is False
    assert _client().delete_push_subscription("s1") is False
    for verb in ("patch", "delete"):
        monkeypatch.setattr(supabase_client.requests, verb, lambda *a, **k: _Resp(500))
    assert _client().update_push_subscription("s1", {"failure_count": 1}) is False
    assert _client().delete_push_subscription("s1") is False


def test_last_failure_reason_is_dropped_once_rejected(monkeypatch):
    bodies = []

    def fake_patch(url, params=None, json=None, headers=None, timeout=None):
        bodies.append(dict(json))
        if "last_failure_reason" in json:
            return _Resp(400, text=MISSING.format(col="last_failure_reason", table="moodle_push_subscriptions"))
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "patch", fake_patch)
    c = _client()
    assert c.push_failure_reason_supported is True
    assert c.update_push_subscription("s1", {"failure_count": 1, "last_failure_reason": "http_400"}) is True
    assert bodies == [{"failure_count": 1, "last_failure_reason": "http_400"}, {"failure_count": 1}]
    assert c.push_failure_reason_supported is False
    assert c.update_push_subscription("s1", {"failure_count": 2, "last_failure_reason": "http_400"}) is True
    assert bodies[2] == {"failure_count": 2} and len(bodies) == 3  # never sent again, no probe


# ---- notification history --------------------------------------------------------------------------


def test_history_insert_strips_push_state_once_rejected(monkeypatch):
    sent = []

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append(json)
        if "push_state" in json[0]:
            return _Resp(400, text=MISSING.format(col="push_state", table="moodle_notification_log"))
        return _Resp(201)

    monkeypatch.setattr(supabase_client.requests, "post", fake_post)
    c = _client()
    rows = [{"id": "n1", "push_state": "ok"}, {"id": "n2", "push_state": "failed"}]
    c.insert_notification_log(rows)
    assert sent[1] == [{"id": "n1"}, {"id": "n2"}] and c.push_state_supported is False
    c.insert_notification_log(rows)
    assert len(sent) == 3 and sent[2] == [{"id": "n1"}, {"id": "n2"}]
    assert rows[0]["push_state"] == "ok"  # the caller's rows are not mutated


def test_history_insert_still_raises_on_other_errors(monkeypatch):
    monkeypatch.setattr(supabase_client.requests, "post", lambda *a, **k: _Resp(400, text="push_state check failed"))
    c = SupabaseClient(url=SB, key="k")
    c.columns.disable("moodle_notification_log", "push_state")
    with pytest.raises(RuntimeError, match="HTTP 400"):
        c.insert_notification_log([{"id": "n1"}])
