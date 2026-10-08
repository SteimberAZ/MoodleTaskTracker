"""Multi-user worker: per-user ids, routing, guards, isolation, legacy gating and schema migration."""
import hashlib
import sqlite3
import threading
import time

import pytest

import api_sync
import notifier
import supabase_client
import worker
from moodle_api import MoodleApiClient, MoodleApiError, MoodleTokenInvalid, event_to_task, make_task_id
from storage import Storage
from supabase_client import SupabaseClient

BASE = "https://m.example"
URL_1 = f"{BASE}/mod/assign/view.php?id=11"
URL_2 = f"{BASE}/mod/assign/view.php?id=22"

UA = {"id": "11111111-aaaa-bbbb-cccc-000000000001", "moodle_url": BASE, "token": "tok-a",
      "ntfy_topic": "utm-aaaaaaaaaaaa", "last_error": None}
UB = {"id": "22222222-aaaa-bbbb-cccc-000000000002", "moodle_url": BASE, "token": "tok-b",
      "ntfy_topic": "utm-bbbbbbbbbbbb", "last_error": None}


class _NoSupabase:
    is_configured = False


class FakeSupabase:
    """Records users PATCHes; fetch_active_users returns/raises what the test configures."""

    is_configured = True

    def __init__(self, users=None, fail=False):
        self.users, self.fail, self.updates = users or [], fail, []

    def fetch_active_users(self):
        if self.fail:
            raise RuntimeError("HTTP 503")
        return list(self.users)

    def update_user(self, user_id, fields):
        self.updates.append((user_id, fields))
        return True


def _storage(tmp_path):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = _NoSupabase()
    return s


def _event(url, hours=5, **over):
    ev = {
        "id": 1, "name": "Tarea", "modulename": "assign", "instance": 9,
        "timesort": int(time.time()) + hours * 3600, "url": url,
        "course": {"fullname": "Fisica"},
        "action": {"actionable": True, "url": url},
    }
    ev.update(over)
    return ev


class EventClient:
    """Stands in for MoodleApiClient: maps events to tasks for one user (no network)."""

    def __init__(self, user_id, events=None, exc=None):
        self.user_id, self.events, self.exc = user_id, events or [], exc

    def fetch_tasks(self):
        if self.exc:
            raise self.exc
        return [event_to_task(e, BASE, user_id=self.user_id) for e in self.events]


class Capture:
    """Replaces the ntfy senders so nothing hits the network or the desktop."""

    def __init__(self, monkeypatch):
        self.pushes = []  # (topic, milestone, title)
        self.toasts = []
        monkeypatch.setattr(
            notifier, "send_whatsapp_alert",
            lambda **k: self.pushes.append((k.get("topic"), k.get("milestone"), k.get("title"))),
        )
        monkeypatch.setattr(notifier, "send_windows_notification", lambda **k: self.toasts.append(k))
        self.alerts = []  # (topic, title)

    def alert(self, **k):
        self.alerts.append((k.get("topic"), k.get("title"), k.get("message")))


# ---- per-user task ids -------------------------------------------------------------------------


def test_task_id_is_md5_of_user_and_url():
    assert make_task_id(URL_1, "u1") == hashlib.md5(f"u1:{URL_1}".encode()).hexdigest()
    assert make_task_id(URL_1) == hashlib.md5(URL_1.encode()).hexdigest()  # legacy scheme intact


def test_same_assignment_gets_different_ids_per_user_and_carries_user_id():
    a = event_to_task(_event(URL_1), BASE, user_id="ua")
    b = event_to_task(_event(URL_1), BASE, user_id="ub")
    assert a["id"] != b["id"]
    assert (a["user_id"], b["user_id"]) == ("ua", "ub")
    assert a["id"] == make_task_id(URL_1, "ua")
    assert "user_id" not in event_to_task(_event(URL_1), BASE)  # legacy dicts stay owner-less


def test_api_client_threads_user_id_into_tasks():
    class Http:
        def post(self, url, data=None, timeout=None):
            class R:
                status_code = 200

                def json(self_inner):
                    if data["wsfunction"] == "core_calendar_get_action_events_by_timesort":
                        return {"events": [_event(URL_1, instance=0)]}
                    return {}
            return R()

    tasks = MoodleApiClient(BASE, "tok", http=Http(), user_id="ua").fetch_tasks(delay=0)
    assert tasks[0]["user_id"] == "ua" and tasks[0]["id"] == make_task_id(URL_1, "ua")


def test_sync_stores_each_users_rows_separately(tmp_path):
    s = _storage(tmp_path)
    cap_alerts = []
    factory = lambda u: EventClient(u["id"], [_event(URL_1, hours=200)])  # noqa: E731
    out = worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=factory,
                                process=lambda *a, **k: None, alert=lambda **k: cap_alerts.append(k))
    assert out == {UA["id"]: "ok", UB["id"]: "ok"}
    rows_a, rows_b = s.get_all_tasks(user_id=UA["id"]), s.get_all_tasks(user_id=UB["id"])
    assert len(rows_a) == len(rows_b) == 1
    assert rows_a[0]["id"] != rows_b[0]["id"]
    assert len(s.get_all_tasks()) == 2


# ---- notification routing ----------------------------------------------------------------------


def test_notifications_go_only_to_the_owning_users_topic(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    ev = {UA["id"]: [_event(URL_1, hours=5)], UB["id"]: [_event(URL_1, hours=5)]}
    factory = lambda u: EventClient(u["id"], ev[u["id"]])  # noqa: E731

    worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=factory, alert=cap.alert)
    # First sync: the 'new' alert is suppressed by the guard, the <8h milestone fires per user.
    assert sorted((t, m) for t, m, _ in cap.pushes) == [(UA["ntfy_topic"], "8h"), (UB["ntfy_topic"], "8h")]
    assert cap.toasts == []  # no desktop toast for other people's tasks

    cap.pushes.clear()
    ev[UA["id"]] = [_event(URL_1, hours=5), _event(URL_2, hours=200, name="Solo A")]
    worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=factory, alert=cap.alert)
    assert cap.pushes == [(UA["ntfy_topic"], "new", "Solo A")]


def test_process_milestones_default_topic_and_desktop_for_legacy_callers(monkeypatch):
    cap = Capture(monkeypatch)

    class Fake:
        def has_notified_milestone(self, *a):
            return False

        def record_milestone(self, *a):
            pass

    t = {"id": "x", "title": "T", "course": "C", "due_date_str": "d", "task_url": "u",
         "status": "pending", "due_timestamp": int(time.time()) + 3600}
    notifier.TaskNotificationManager.process_milestones([t], Fake())
    assert cap.pushes == [(None, "8h", "T")]  # None -> env NTFY_TOPIC inside send_whatsapp_alert
    assert len(cap.toasts) == 1


class _SyncThread:
    def __init__(self, target=None, daemon=None, **_):
        self.target = target

    def start(self):
        self.target()


@pytest.fixture
def ntfy_posts(monkeypatch):
    import requests

    posts = []

    class Resp:
        status_code = 200
        text = ""

    monkeypatch.setattr(requests, "post", lambda url, **kw: posts.append(url) or Resp())
    monkeypatch.setattr(threading, "Thread", _SyncThread)
    monkeypatch.delenv("NTFY_SERVER", raising=False)
    monkeypatch.setenv("NTFY_TOPIC", "owner-topic")
    return posts


def test_senders_post_to_the_given_topic_or_the_env_owner_topic(ntfy_posts):
    notifier.send_whatsapp_alert("T", "C", "d", topic="utm-user1")
    notifier.send_system_alert("t", "m", topic="utm-user2")
    assert notifier.post_ntfy("t", "m", topic="utm-user3") is True
    notifier.send_whatsapp_alert("T", "C", "d")
    notifier.send_system_alert("t", "m")
    notifier.post_ntfy("t", "m")
    assert [u.rsplit("/", 1)[1] for u in ntfy_posts] == [
        "utm-user1", "utm-user2", "utm-user3", "owner-topic", "owner-topic", "owner-topic",
    ]


def test_mask_topic_hides_the_secret_part():
    assert notifier.mask_topic("utm-abcdefghijklmnopqrst") == "utm-abcd…"
    assert "efgh" not in notifier.mask_topic("utm-abcdefghijklmnopqrst")
    assert notifier.mask_topic("") == "…"


# ---- first-sync guard (per user) ---------------------------------------------------------------


def test_first_sync_guard_is_per_user(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    far = lambda *urls: [_event(u, hours=300) for u in urls]  # noqa: E731

    # A has been syncing for a while.
    api_sync_a = {"events": far(URL_1)}
    factory = lambda u: EventClient(u["id"], api_sync_a["events"] if u is UA else api_sync_b["events"])  # noqa: E731
    api_sync_b = {"events": far(URL_1, URL_2)}
    worker.sync_all_users(s, _NoSupabase(), [UA], client_factory=factory, alert=cap.alert)
    assert s.get_setting(api_sync.migration_flag_key(UA["id"])) == "1"
    assert s.get_setting(api_sync.migration_flag_key(UB["id"]), "") == ""

    # B registers later with an existing backlog: no 'new' spam, even though A's flag is set.
    worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=factory, alert=cap.alert)
    assert cap.pushes == []
    assert s.get_setting(api_sync.migration_flag_key(UB["id"])) == "1"

    # After the guard, a genuinely new task for B is announced to B only.
    api_sync_b["events"] = far(URL_1, URL_2, f"{BASE}/mod/assign/view.php?id=33")
    worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=factory, alert=cap.alert)
    assert [(t, m) for t, m, _ in cap.pushes] == [(UB["ntfy_topic"], "new")]


# ---- invalid token isolation -------------------------------------------------------------------


def test_invalid_token_for_a_updates_only_a_alerts_only_a_once_and_b_still_syncs(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    sb = FakeSupabase([UA, UB])
    bad = MoodleTokenInvalid("bad token", code="invalidtoken")
    factory = lambda u: EventClient(u["id"], [_event(URL_1, hours=300)], exc=bad if u is UA else None)  # noqa: E731

    outcomes = []
    for _ in range(3):
        outcomes.append(worker.sync_all_users(s, sb, [UA, UB], client_factory=factory, alert=cap.alert))
    assert all(o == {UA["id"]: "invalid", UB["id"]: "ok"} for o in outcomes)

    assert {uid for uid, _ in sb.updates} == {UA["id"]}  # B's row never touched
    assert all(f["last_error"].startswith("invalidtoken") and f["last_error_at"] for _, f in sb.updates)
    assert len(cap.alerts) == 1  # dedup'd across ticks
    topic, title, message = cap.alerts[0]
    assert topic == UA["ntfy_topic"] and title == "Moodle desconectado"
    assert message == "Moodle desconectado: vuelve a iniciar sesión en la web"
    assert len(s.get_all_tasks(user_id=UB["id"])) == 1 and s.get_all_tasks(user_id=UA["id"]) == []


def test_accessexception_is_treated_as_invalid_token(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    bad = MoodleTokenInvalid("denied", code="accessexception")
    out = api_sync.sync_user_via_api(s, UA, FakeSupabase(), client=EventClient(UA["id"], exc=bad), alert=cap.alert)
    assert out == "invalid" and len(cap.alerts) == 1


def test_recovery_clears_error_and_rearms_dedup_for_that_user_only(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    sb = FakeSupabase()
    bad = MoodleTokenInvalid("bad", code="invalidtoken")
    api_sync.sync_user_via_api(s, UA, sb, client=EventClient(UA["id"], exc=bad), alert=cap.alert)
    assert s.get_setting(api_sync.alert_setting_key(UA["id"]))
    assert s.get_setting(api_sync.alert_setting_key(UB["id"]), "") == ""

    out = api_sync.sync_user_via_api(s, UA, sb, client=EventClient(UA["id"], [_event(URL_1, hours=300)]),
                                     process=lambda *a, **k: None, alert=cap.alert)
    assert out == "ok"
    assert sb.updates[-1] == (UA["id"], {"last_error": None, "last_error_at": None})
    assert cap.alerts[-1][:2] == (UA["ntfy_topic"], "Moodle reconectado")

    # Failing again alerts again (dedup was reset on recovery).
    api_sync.sync_user_via_api(s, UA, sb, client=EventClient(UA["id"], exc=bad), alert=cap.alert)
    assert [a[1] for a in cap.alerts] == ["Moodle desconectado", "Moodle reconectado", "Moodle desconectado"]


def test_stale_last_error_on_healthy_user_is_cleared_without_alert(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    sb = FakeSupabase()
    user = dict(UA, last_error="invalidtoken: old")
    out = api_sync.sync_user_via_api(s, user, sb, client=EventClient(UA["id"], []),
                                     process=lambda *a, **k: None, alert=cap.alert)
    assert out == "ok" and cap.alerts == []
    assert sb.updates == [(UA["id"], {"last_error": None, "last_error_at": None})]


def test_one_failing_user_never_blocks_the_others(tmp_path, monkeypatch):
    Capture(monkeypatch)
    s = _storage(tmp_path)

    def factory(u):
        if u is UA:
            raise RuntimeError("boom building client")
        return EventClient(u["id"], [_event(URL_1, hours=300)], exc=None)

    out = worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=factory)
    assert out == {UA["id"]: "error", UB["id"]: "ok"}

    flaky = lambda u: EventClient(u["id"], exc=MoodleApiError("down", code="network") if u is UA else None)  # noqa: E731
    out = worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=flaky)
    assert out == {UA["id"]: "error", UB["id"]: "ok"}


def test_user_without_topic_or_token_is_skipped_never_sent_to_owner(tmp_path, monkeypatch):
    cap = Capture(monkeypatch)
    s = _storage(tmp_path)
    out = worker.sync_all_users(
        s, _NoSupabase(), [dict(UA, ntfy_topic=""), dict(UB, token=None)],
        client_factory=lambda u: EventClient(u["id"], [_event(URL_1)]),
    )
    assert set(out.values()) == {"skipped"} and cap.pushes == [] and s.get_all_tasks() == []


# ---- legacy gating -----------------------------------------------------------------------------


def test_legacy_runs_only_when_there_are_zero_active_users(tmp_path, monkeypatch):
    Capture(monkeypatch)
    s = _storage(tmp_path)
    legacy_calls = []

    with_users = FakeSupabase([UA])
    r = worker.run_task_tick(s, with_users, lambda: legacy_calls.append(1),
                             client_factory=lambda u: EventClient(u["id"], []), process=lambda *a, **k: None)
    assert r == "users" and legacy_calls == []

    r = worker.run_task_tick(s, FakeSupabase([]), lambda: legacy_calls.append(1))
    assert r == "legacy" and legacy_calls == [1]


def test_users_fetch_failure_skips_the_round_without_legacy_fallback(tmp_path, capsys):
    s = _storage(tmp_path)
    legacy_calls = []
    r = worker.run_task_tick(s, FakeSupabase(fail=True), lambda: legacy_calls.append(1))
    assert r == "skipped" and legacy_calls == []
    assert "sin respaldo legacy" in capsys.readouterr().out


def test_unconfigured_database_means_no_users_and_legacy_runs(tmp_path, monkeypatch):
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "SUPABASE_ANON_KEY", "MOODLE_DB_JWT"):
        monkeypatch.delenv(k, raising=False)
    client = SupabaseClient(url="", key="")
    assert client.fetch_active_users() == []
    calls = []
    assert worker.run_task_tick(_storage(tmp_path), client, lambda: calls.append(1)) == "legacy"
    assert calls == [1]


def test_logs_never_contain_tokens_or_full_topics(tmp_path, monkeypatch, capsys):
    Capture(monkeypatch)
    s = _storage(tmp_path)
    worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=lambda u: EventClient(u["id"], [_event(URL_1)]))
    out = capsys.readouterr().out
    for secret in (UA["token"], UB["token"], UA["ntfy_topic"], UB["ntfy_topic"]):
        assert secret not in out
    assert "utm-aaaa…" in out


# ---- SQLite migration --------------------------------------------------------------------------


def test_sqlite_migration_adds_user_id_without_losing_rows(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute("""CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, course TEXT, due_date_str TEXT, due_timestamp INTEGER,
        task_url TEXT, status TEXT DEFAULT 'pending', first_seen INTEGER, last_updated INTEGER,
        is_notified INTEGER DEFAULT 0, is_dismissed INTEGER DEFAULT 0)""")
    conn.execute("INSERT INTO tasks (id, title, course, due_timestamp, status) VALUES ('old1', 'Vieja', 'C', 5, 'pending')")
    conn.commit()
    conn.close()

    s = Storage(str(db))
    s.supabase = _NoSupabase()
    rows = s.get_all_tasks()
    assert [(r["id"], r["title"], r["user_id"]) for r in rows] == [("old1", "Vieja", None)]
    assert s.get_all_tasks(user_id="nobody") == []

    # Re-opening is a no-op (migration is idempotent) and new rows can be owned.
    s2 = Storage(str(db))
    s2.supabase = _NoSupabase()
    s2.save_tasks([{"id": "n1", "title": "Nueva", "user_id": "ua"}])
    assert [r["id"] for r in s2.get_all_tasks(user_id="ua")] == ["n1"]
    assert len(s2.get_all_tasks()) == 2


def test_sync_of_one_user_never_touches_other_users_rows(tmp_path, monkeypatch):
    Capture(monkeypatch)
    s = _storage(tmp_path)
    worker.sync_all_users(s, _NoSupabase(), [UA, UB], client_factory=lambda u: EventClient(u["id"], [_event(URL_1, 300), _event(URL_2, 300)]))
    # A's next sync no longer lists URL_2; B's rows must be untouched.
    worker.sync_all_users(s, _NoSupabase(), [UA], client_factory=lambda u: EventClient(u["id"], [_event(URL_1, 300)]))
    assert len(s.get_all_tasks(user_id=UB["id"])) == 2


# ---- Supabase REST shapes ----------------------------------------------------------------------


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code, self._payload, self.text = status, payload if payload is not None else [], ""

    def json(self):
        return self._payload


def test_fetch_active_users_query_and_filtering(monkeypatch):
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen.update(url=url, params=params)
        return _Resp(200, [dict(UA), dict(UB, token="  ")])

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    users = SupabaseClient(url="https://sb.example", key="k").fetch_active_users()
    assert [u["id"] for u in users] == [UA["id"]]  # blank tokens dropped
    assert seen["url"] == "https://sb.example/rest/v1/moodle_users"
    assert seen["params"] == {
        "active": "eq.true",
        "token": "not.is.null",
        "select": "id,moodle_url,site_userid,username,fullname,token,ntfy_topic,is_admin,last_error,last_error_at,last_login_at",
    }


def test_fetch_active_users_raises_on_failure(monkeypatch):
    monkeypatch.setattr(supabase_client.requests, "get", lambda *a, **k: _Resp(503))
    with pytest.raises(RuntimeError):
        SupabaseClient(url="https://sb.example", key="k").fetch_active_users()

    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(supabase_client.requests, "get", boom)
    with pytest.raises(ConnectionError):
        SupabaseClient(url="https://sb.example", key="k").fetch_active_users()


def test_update_user_patches_by_id(monkeypatch):
    seen = {}

    def fake_patch(url, params=None, json=None, headers=None, timeout=None):
        seen.update(url=url, params=params, json=json, prefer=headers["Prefer"])
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "patch", fake_patch)
    assert SupabaseClient(url="https://sb.example", key="k").update_user("uid-1", {"last_error": None}) is True
    assert seen == {"url": "https://sb.example/rest/v1/moodle_users", "params": {"id": "eq.uid-1"},
                    "json": {"last_error": None}, "prefer": "return=minimal"}


def test_due_reminders_query_joins_owner_topic(monkeypatch):
    seen = {}
    monkeypatch.setattr(supabase_client.requests, "get",
                        lambda url, params=None, headers=None, timeout=None: seen.update(params=params) or _Resp(200, []))
    SupabaseClient(url="https://sb.example", key="k").fetch_due_reminders("2026-01-01T00:00:00+00:00")
    p = seen["params"]
    assert p["select"] == "*,moodle_users(ntfy_topic,active)"
    assert p["user_id"] == "not.is.null" and p["active"] == "eq.true"
    assert p["next_fire_at"] == "lte.2026-01-01T00:00:00+00:00"


def test_task_upsert_includes_user_id_and_drops_ownerless_rows(monkeypatch):
    sent = []
    monkeypatch.setattr(supabase_client.requests, "post",
                        lambda url, json=None, headers=None, timeout=None: sent.append((url, json)) or _Resp(201))
    c = SupabaseClient(url="https://sb.example", key="k")
    owned = {"id": "t1", "title": "T", "user_id": "ua"}
    legacy = {"id": "t2", "title": "L"}
    c.upsert_tasks([owned, legacy], async_call=False)
    assert len(sent) == 1 and sent[0][0] == "https://sb.example/rest/v1/moodle_tasks?on_conflict=id"
    assert [r["id"] for r in sent[0][1]] == ["t1"] and sent[0][1][0]["user_id"] == "ua"
    c.upsert_tasks([legacy], async_call=False)
    assert len(sent) == 1  # nothing owned -> no request
