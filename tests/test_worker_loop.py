"""Worker loop: delivery cadence, round budget, stop handling, crash survival and the login poll."""
import json
import signal
import threading

import pytest

import delivery
import worker
from moodle_api import MoodleNetworkError
from storage import Storage

UID = "11111111-aaaa-bbbb-cccc-000000000001"


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


class History:
    def __init__(self):
        self.flushes, self.prunes = 0, 0

    def flush(self):
        self.flushes += 1
        return 0

    def prune_if_due(self, storage):
        self.prunes += 1
        return False


class OffSender:
    enabled, status, warning = False, "Web Push: disabled (test)", None


def _ctx(clock=None, supabase=None, history=None, stop_event=None):
    return worker.WorkerContext(None, supabase, OffSender(), history or History(), lambda *a, **k: True,
                                stop_event=stop_event, clock=clock or Clock())


@pytest.fixture
def steps(monkeypatch):
    """Replaces the four delivery steps with recorders."""
    calls = []
    for name in ("process_class_reminders", "check_and_notify_upcoming_classes", "process_due_reminders",
                 "process_push_tests"):
        monkeypatch.setattr(worker, name, lambda *a, _n=name, **k: calls.append(_n))
    return calls


def _users(n):
    return [{"id": f"u{i}", "ntfy_topic": f"utm-{i}", "token": "t", "moodle_url": "https://m.example"}
            for i in range(n)]


# ---- delivery pass ------------------------------------------------------------------------------------


def test_the_delivery_pass_runs_every_step_then_flushes(steps):
    ctx = _ctx()
    worker.run_delivery_pass(ctx)
    assert steps == ["process_class_reminders", "check_and_notify_upcoming_classes", "process_due_reminders",
                     "process_push_tests"]
    assert ctx.history.flushes == 1


def test_a_failing_step_does_not_stop_the_others(monkeypatch, steps, capsys):
    def boom(*a, **k):
        raise RuntimeError("down")

    monkeypatch.setattr(worker, "process_due_reminders", boom)
    ctx = _ctx()
    worker.run_delivery_pass(ctx)
    assert steps == ["process_class_reminders", "check_and_notify_upcoming_classes", "process_push_tests"]
    assert "Error en recordatorios personalizados: down" in capsys.readouterr().out
    assert ctx.history.flushes == 1


def test_a_stop_lands_between_steps_and_the_history_is_still_flushed(monkeypatch, steps):
    ctx = _ctx()
    monkeypatch.setattr(worker, "check_and_notify_upcoming_classes", lambda *a, **k: ctx.stop_event.set())
    worker.run_delivery_pass(ctx)
    assert steps == ["process_class_reminders"]
    assert ctx.history.flushes == 1


def test_a_slow_round_over_five_users_still_runs_the_delivery_pass_between_users(monkeypatch, steps):
    clock = Clock()
    ctx = _ctx(clock)
    worker.run_delivery_pass(ctx)  # the tick's own pass
    steps.clear()
    synced = []

    def slow_sync(storage, user, *a, **k):
        synced.append(user["id"])
        clock.advance(35)  # Moodle answers slowly
        return "ok"

    monkeypatch.setattr(worker, "sync_user_via_api", slow_sync)
    out = worker.sync_all_users(None, None, _users(5), between_users=ctx.delivery_if_due, clock=clock)
    assert synced == ["u0", "u1", "u2", "u3", "u4"] and set(out.values()) == {"ok"}
    # 35 s per user: the pass is due before users 2 and 4 (at most once per 60 s), never before user 0
    assert steps.count("process_class_reminders") == 2
    assert ctx.max_delivery_gap == 70


def test_a_fast_round_does_not_repeat_the_delivery_pass(monkeypatch, steps):
    ctx = _ctx()
    worker.run_delivery_pass(ctx)
    steps.clear()
    monkeypatch.setattr(worker, "sync_user_via_api", lambda *a, **k: "ok")
    worker.sync_all_users(None, None, _users(3), between_users=ctx.delivery_if_due, clock=ctx.clock)
    assert steps == []


# ---- round budget, rotation, breaker, stop ------------------------------------------------------------


def test_the_round_budget_carries_unreached_users_to_the_front_of_the_next_round(monkeypatch, capsys):
    clock = Clock()
    synced = []

    def sync(storage, user, *a, **k):
        synced.append(user["id"])
        clock.advance(40)
        return "ok"

    monkeypatch.setattr(worker, "sync_user_via_api", sync)
    planner = worker.RoundPlanner()
    users = _users(5)
    ordered = planner.order(users)
    out = worker.sync_all_users(None, None, ordered, budget_seconds=100, clock=clock)
    planner.record(ordered, out)
    assert synced == ["u0", "u1", "u2"]
    assert out["u3"] == out["u4"] == "deferred"
    assert "round budget" in capsys.readouterr().out
    assert [u["id"] for u in planner.order(users)][:2] == ["u3", "u4"]


def test_the_round_order_rotates_when_everyone_was_reached():
    planner, users = worker.RoundPlanner(), _users(3)
    firsts = []
    for _ in range(3):
        ordered = planner.order(users)
        planner.record(ordered, {u["id"]: "ok" for u in ordered})
        firsts.append(ordered[0]["id"])
    assert firsts == ["u0", "u1", "u2"]


def test_the_circuit_breaker_aborts_the_round_after_three_network_errors(monkeypatch, capsys):
    class DownClient:
        def fetch_tasks(self):
            raise MoodleNetworkError("timeout", code="network")

    tried = []

    def factory(user):
        tried.append(user["id"])
        return DownClient()

    out = worker.sync_all_users(_NoStorage(), None, _users(5), client_factory=factory)
    assert tried == ["u0", "u1", "u2"]
    assert [out[f"u{i}"] for i in range(5)] == ["error", "error", "error", "deferred", "deferred"]
    assert capsys.readouterr().out.count("Moodle unreachable") == 1


class _NoStorage:
    """sync_tasks_via_api only touches storage after a successful fetch."""


def test_a_stop_request_defers_the_remaining_users(monkeypatch):
    stop = threading.Event()

    def sync(storage, user, *a, **k):
        stop.set()
        return "ok"

    monkeypatch.setattr(worker, "sync_user_via_api", sync)
    out = worker.sync_all_users(None, None, _users(3), stop_event=stop, pause_seconds=0.5)
    assert out == {"u0": "ok", "u1": "deferred", "u2": "deferred"}


def test_the_pause_between_users_is_interruptible(monkeypatch):
    waits = []

    class Stop(threading.Event):
        def wait(self, timeout=None):
            waits.append(timeout)
            return False

    monkeypatch.setattr(worker, "sync_user_via_api", lambda *a, **k: "ok")
    worker.sync_all_users(None, None, _users(3), stop_event=Stop(), pause_seconds=0.5)
    assert waits == [0.5, 0.5]


def test_deferred_users_are_not_remembered_as_synced(monkeypatch):
    class Users:
        def fetch_active_users(self):
            return [dict(u, last_login_at="L") for u in _users(2)]

    monkeypatch.setattr(worker, "sync_all_users", lambda st, sb, users, **k: {"u0": "ok", "u1": "deferred"})
    seen, stats = {}, {}
    assert worker.run_task_tick(None, Users(), seen_logins=seen, stats=stats) == "users"
    assert seen == {"u0": "L"}
    assert stats == {"users_ok": 1, "users_err": 0, "users_deferred": 1, "error": False}


# ---- no legacy path -----------------------------------------------------------------------------------


def test_an_empty_users_list_never_takes_a_legacy_path(capsys):
    class Empty:
        def fetch_active_users(self):
            return []

    stats = {}
    assert worker.run_task_tick(None, Empty(), stats=stats) == "skipped"
    assert "no active users" in capsys.readouterr().out
    assert stats["error"] is False
    for name in ("legacy_check_tasks", "legacy_keep_alive", "LegacyState", "_read_env_cookie", "MoodleClient"):
        assert not hasattr(worker, name)


def test_an_unreadable_users_table_is_a_failed_round():
    class Down:
        def fetch_active_users(self):
            raise RuntimeError("HTTP 503")

    stats = {}
    assert worker.run_task_tick(None, Down(), stats=stats) == "skipped"
    assert stats["error"] is True


# ---- reminders ------------------------------------------------------------------------------------------


def test_a_reminder_linked_to_a_task_opens_that_task_and_renotifies():
    calls = []
    send = worker.reminder_deliverer(lambda user, title, body, **kw: calls.append(kw) or True)
    assert send({"id": UID}, {"id": "r1", "task_id": "abc123"}, "Entregar", "Hoy") is True
    assert send({"id": UID}, {"id": "r2", "task_id": None}, "Agua", "Ahora") is True
    assert [c["url"] for c in calls] == ["/tareas/abc123", "/"]
    assert all(c["renotify"] is True and c["kind"] == "reminder" for c in calls)


def test_renotify_is_left_out_for_a_deliverer_that_does_not_take_it():
    calls = []

    def old_deliver(user, title, body, url="/", tag="", priority="default", *, ttl=0, ntfy_tags="", kind=None):
        calls.append(url)
        return True

    send = worker.reminder_deliverer(old_deliver)
    assert send({"id": UID}, {"id": "r1", "task_id": "t1"}, "x", "y") is True
    assert calls == ["/tareas/t1"]


# ---- the loop -------------------------------------------------------------------------------------------


def test_the_wait_is_the_remainder_of_the_tick(monkeypatch):
    clock = Clock()
    ctx = _ctx(clock)
    ticks, waits = [], []

    def tick(c):
        ticks.append(1)
        clock.advance(15 if len(ticks) == 1 else 75)

    def wait(seconds):
        waits.append(seconds)
        if len(waits) == 2:
            ctx.stop_event.set()

    monkeypatch.setattr(worker, "run_tick", tick)
    worker.run_loop(ctx, tick_seconds=60, wait=wait)
    assert waits == [45, 0.0]


def test_a_stop_during_a_tick_ends_the_loop_without_waiting(monkeypatch):
    ctx = _ctx()
    waits = []
    monkeypatch.setattr(worker, "run_tick", lambda c: c.stop_event.set())
    worker.run_loop(ctx, wait=waits.append)
    assert waits == []


def test_a_stopped_tick_skips_the_moodle_round(monkeypatch, steps):
    ctx = _ctx()
    ctx.stop_event.set()
    monkeypatch.setattr(worker, "run_task_tick", lambda *a, **k: pytest.fail("must not sync"))
    worker.run_tick(ctx)
    assert steps == [] and ctx.history.flushes >= 1


def test_a_crashing_tick_is_logged_and_the_history_still_flushed(monkeypatch, steps, capsys):
    ctx = _ctx()

    def crash(*a, **k):
        raise RuntimeError("tick crashed")

    monkeypatch.setattr(worker, "run_task_tick", crash)
    worker.run_tick(ctx)  # does not raise
    out = capsys.readouterr().out
    assert "Traceback" in out and "tick crashed" in out
    assert ctx.tick_crashed is True
    assert ctx.history.flushes == 2 and ctx.history.prunes == 1


def test_signals_set_the_stop_event_and_are_restored():
    stop = threading.Event()
    before = signal.getsignal(signal.SIGINT)
    restore = worker.install_stop_handlers(stop)
    try:
        handler = signal.getsignal(signal.SIGINT)
        assert handler is not before
        handler(signal.SIGINT, None)
        assert stop.is_set()
        with pytest.raises(KeyboardInterrupt):  # a second signal aborts at once
            handler(signal.SIGINT, None)
    finally:
        restore()
    assert signal.getsignal(signal.SIGINT) is before


# ---- moved from test_notification_log: the loop survives a crashing tick --------------------------------


class LogDb:
    is_configured = True

    def __init__(self):
        self.inserts, self.prunes = [], []

    def insert_notification_log(self, rows):
        self.inserts.append([dict(r) for r in rows])

    def prune_notification_log(self, cutoff_iso):
        self.prunes.append(cutoff_iso)

    def fetch_milestones_since(self, days=14):
        return []

    def fetch_settings_like(self, prefix):
        return []

    @property
    def rows(self):
        return [r for batch in self.inserts for r in batch]


def test_the_worker_survives_a_crashing_tick_and_still_flushes_the_history(monkeypatch, tmp_path):
    db = LogDb()

    class Offline:
        is_configured, url = False, ""

    storage = Storage(str(tmp_path / "t.db"))
    storage.supabase = Offline()
    storage.set_setting("check_interval_mins", "0")  # every tick runs a Moodle round
    monkeypatch.setattr(worker, "Storage", lambda: storage)
    monkeypatch.setattr(worker.SupabaseClient, "for_worker", classmethod(lambda cls: db))
    monkeypatch.setattr(worker.WebPushSender, "from_env", classmethod(lambda cls, sb: OffSender()))
    rounds = []
    # A distinct tag per round: delivery backs off a failed key, so reusing one tag would record only one row.
    monkeypatch.setattr(worker, "process_class_reminders",
                        lambda st, sb, deliver: deliver({"id": UID, "ntfy_topic": ""}, "Clase", "Hoy", kind="class",
                                                        tag=f"class-round-{len(rounds)}"))
    for name in ("check_and_notify_upcoming_classes", "process_due_reminders", "process_push_tests"):
        monkeypatch.setattr(worker, name, lambda *a, **k: 0)

    def tick(*a, stop_event=None, **k):
        rounds.append(1)
        if len(rounds) == 1:
            raise RuntimeError("tick crashed")
        stop_event.set()
        return "users"

    monkeypatch.setattr(worker, "run_task_tick", tick)
    worker.run_worker(tick_seconds=0)  # returns once the second round asks to stop
    assert len(rounds) == 2  # the crash did not end the loop
    assert [(r["kind"], r["status"], r["title"]) for r in db.rows] == [("class", "failed", "Clase")] * 2
    assert len(db.prunes) == 1  # daily prune, once


# ---- cheap login poll -----------------------------------------------------------------------------------


class MarkerDb:
    def __init__(self, markers, rows):
        self.markers, self.rows, self.asked = markers, rows, []

    def fetch_login_markers(self):
        return list(self.markers)

    def fetch_users_by_ids(self, ids):
        self.asked.append(list(ids))
        return [r for r in self.rows if r["id"] in ids]

    def fetch_active_users(self):
        raise AssertionError("the full read is not needed when markers exist")


def test_the_login_poll_reads_tokens_only_for_changed_users():
    rows = [dict(u, last_login_at="L2" if u["id"] == "u1" else "L1") for u in _users(3)]
    db = MarkerDb([{"id": r["id"], "last_login_at": r["last_login_at"]} for r in rows], rows)
    seen = {"u0": "L1", "u1": "L1", "u2": "L1"}
    assert [u["id"] for u in worker.fetch_fresh_logins(db, seen)] == ["u1"]
    assert db.asked == [["u1"]]
    seen["u1"] = "L2"
    assert worker.fetch_fresh_logins(db, seen) == [] and db.asked == [["u1"]]


def test_the_login_poll_falls_back_to_the_full_read():
    class Plain:
        def fetch_active_users(self):
            return [{"id": "u0", "last_login_at": "L9", "token": "t"}]

    assert [u["id"] for u in worker.fetch_fresh_logins(Plain(), {"u0": "L1"})] == ["u0"]


# ---- heartbeat ------------------------------------------------------------------------------------------

HEARTBEAT_KEYS = {"at", "version", "webpush_enabled", "push_status", "last_push_ok_at", "push_counts", "users_ok",
                  "users_err", "last_round_mode", "tick_seconds", "sync_seconds", "delivery_lag_seconds",
                  "degraded", "degraded_reasons"}


@pytest.fixture(autouse=True)
def _no_health_env(monkeypatch):
    for name in ("HEALTHCHECK_URL", "WORKER_STRICT", "WORKER_VERSION"):
        monkeypatch.delenv(name, raising=False)
    worker._LOGGED_ONCE.clear()
    delivery.reset_delivery_state()  # module-level retry state must not leak between tests


class OnSender:
    enabled = True
    status = "Web Push: enabled (key from vapid_private.pem; public key BPUB; subject mailto:owner@example.com)"
    warning = None
    public_key_b64 = "BPUB"

    def __init__(self, stats=None):
        self.stats = stats
        self.resets = []

    def stats_snapshot(self, reset=True):
        self.resets.append(reset)
        return dict(self.stats or {})


class SettingsDb:
    is_configured = True

    def __init__(self, fail=None, result=True):
        self.fail, self.result, self.settings = fail, result, []

    def upsert_setting(self, key, value, async_call=True):
        if self.fail:
            raise self.fail
        self.settings.append((key, value, async_call))
        return self.result


def test_the_heartbeat_has_the_contract_keys_and_no_secrets():
    stats = {"sent_ok": 3, "failed": 1, "transient": 0, "gone": 0, "server_errors": {"503": 1},
             "last_ok_at": "2026-10-08T12:00:00+00:00",
             "last_error": "HTTP 410 for https://fcm.googleapis.com/fcm/send/SECRET-TOKEN"}
    ctx = worker.WorkerContext(None, SettingsDb(), OnSender(stats), History(), lambda *a, **k: True, clock=Clock())
    ctx.version, ctx.users_ok, ctx.users_err, ctx.last_round_mode = "abc1234", 4, 1, "users"
    ctx.max_delivery_gap = 95
    payload = worker.build_heartbeat(ctx, 12.34, 8.0)
    assert set(payload) == HEARTBEAT_KEYS
    assert payload["webpush_enabled"] is True and payload["version"] == "abc1234"
    assert payload["last_push_ok_at"] == "2026-10-08T12:00:00+00:00"
    assert payload["push_counts"]["sent_ok"] == 3 and "last_ok_at" not in payload["push_counts"]
    assert (payload["users_ok"], payload["users_err"], payload["last_round_mode"]) == (4, 1, "users")
    assert (payload["tick_seconds"], payload["sync_seconds"], payload["delivery_lag_seconds"]) == (12.3, 8.0, 35.0)
    assert payload["degraded"] is False and payload["degraded_reasons"] == []
    text = json.dumps(payload)
    assert "owner@example.com" not in text and "SECRET-TOKEN" not in text and "fcm.googleapis" not in text
    assert ctx.max_delivery_gap == 0  # the lag is reported once
    assert "BPUB" in payload["push_status"]  # the public key is public and helps compare with the web


def test_the_last_push_ok_is_kept_across_heartbeats_and_counts_are_optional():
    sender = OnSender({"sent_ok": 1, "last_ok_at": "T1"})
    ctx = worker.WorkerContext(None, SettingsDb(), sender, History(), lambda *a, **k: True)
    worker.build_heartbeat(ctx, 1, 0)
    sender.stats = {"sent_ok": 0, "last_ok_at": None}
    assert worker.build_heartbeat(ctx, 1, 0)["last_push_ok_at"] == "T1"
    assert sender.resets == [True, True]
    assert worker.build_heartbeat(_ctx(), 1, 0)["push_counts"] is None  # sender without stats_snapshot


def test_the_heartbeat_is_written_synchronously_every_tick(steps):
    class Users(SettingsDb):
        def fetch_active_users(self):
            return []

    db = Users()
    ctx = worker.WorkerContext(None, db, OffSender(), History(), lambda *a, **k: True)
    ctx.degraded_reasons = ["webpush_disabled"]
    worker.run_tick(ctx)
    (key, value, async_call), = db.settings
    assert key == "worker_status" and async_call is False
    payload = json.loads(value)
    assert payload["last_round_mode"] == "skipped" and payload["degraded"] is True
    assert payload["degraded_reasons"] == ["webpush_disabled"]


def test_a_long_round_refreshes_the_heartbeat_between_users(monkeypatch, steps):
    clock = Clock()
    db = SettingsDb()
    ctx = worker.WorkerContext(None, db, OffSender(), History(), lambda *a, **k: True, clock=clock)
    worker.run_delivery_pass(ctx)
    worker.report_tick(ctx, 0, 0)  # the previous end-of-tick heartbeat
    db.settings.clear()

    def slow_sync(storage, user, *a, **k):
        clock.advance(35)
        return "ok"

    monkeypatch.setattr(worker, "sync_user_via_api", slow_sync)
    # 8 users x 35 s = 280 s: far past the web's 180 s stale threshold without a mid-round heartbeat
    worker.sync_all_users(None, None, _users(8), between_users=ctx.delivery_if_due, clock=clock)
    beats = [k for k, _v, _a in db.settings if k == "worker_status"]
    assert len(beats) >= 3
    assert len(beats) <= 280 // worker.HEARTBEAT_INTERVAL_SECONDS  # at most one per interval


def test_the_startup_heartbeat_is_written_before_the_first_round(monkeypatch, tmp_path):
    class Db(SettingsDb):
        def fetch_active_users(self):
            return []

    class Offline:
        is_configured, url = False, ""

    db = Db()
    storage = Storage(str(tmp_path / "t.db"))
    storage.supabase = Offline()
    monkeypatch.setattr(worker, "Storage", lambda: storage)
    monkeypatch.setattr(worker.SupabaseClient, "for_worker", classmethod(lambda cls: db))
    monkeypatch.setattr(worker.WebPushSender, "from_env", classmethod(lambda cls, sb: OffSender()))
    monkeypatch.setattr(worker, "hydrate_storage", lambda *a: True)
    stop = threading.Event()
    monkeypatch.setattr(worker, "run_loop", lambda ctx, *a: stop.set())
    worker.run_worker(stop_event=stop, tick_seconds=0)
    (key, value, _async), = db.settings
    assert key == "worker_status" and json.loads(value)["degraded_reasons"] == ["webpush_disabled"]


@pytest.mark.parametrize("db", [SettingsDb(fail=RuntimeError("down")), SettingsDb(result=False)])
def test_a_failing_heartbeat_write_never_raises(db, capsys):
    ctx = worker.WorkerContext(None, db, OffSender(), History(), lambda *a, **k: True)
    assert worker.write_heartbeat(ctx, {"at": "x"}) is False
    assert worker.write_heartbeat(ctx, {"at": "y"}) is False
    assert capsys.readouterr().out.count("worker_status") == 1  # logged once, not every tick


def test_a_crashing_heartbeat_build_never_breaks_the_tick(monkeypatch, steps):
    def boom(*a):
        raise RuntimeError("boom")

    ctx = worker.WorkerContext(None, SettingsDb(), OffSender(), History(), lambda *a, **k: True)
    monkeypatch.setattr(worker, "build_heartbeat", boom)
    ctx.stop_event.set()
    worker.run_tick(ctx)  # does not raise


def test_broken_sender_stats_never_break_the_heartbeat():
    class BadSender(OffSender):
        def stats_snapshot(self, reset=True):
            raise RuntimeError("stats down")

    ctx = worker.WorkerContext(None, SettingsDb(), BadSender(), History(), lambda *a, **k: True)
    assert worker.build_heartbeat(ctx, 1, 0)["push_counts"] is None


def test_no_heartbeat_without_a_configured_database():
    class Offline(SettingsDb):
        is_configured = False

    db = Offline()
    ctx = worker.WorkerContext(None, db, OffSender(), History(), lambda *a, **k: True)
    assert worker.write_heartbeat(ctx, {}) is False and db.settings == []


def test_the_version_prefers_the_env_then_git(monkeypatch):
    assert worker.worker_version({"WORKER_VERSION": "v42"}) == "v42"

    def no_git(*a, **k):
        raise FileNotFoundError("git")

    monkeypatch.setattr(worker.subprocess, "run", no_git)
    assert worker.worker_version({}) == worker.WORKER_VERSION


# ---- dead-man switch ------------------------------------------------------------------------------------


def test_the_healthcheck_pings_the_url_and_appends_fail_when_unhealthy():
    calls = []

    def get(url, timeout):
        calls.append((url, timeout))

    env = {"HEALTHCHECK_URL": "https://hc.example/abc/"}
    healthy = worker.WorkerContext(None, None, OnSender(), History(), lambda *a, **k: True)
    worker.ping_healthcheck(healthy, http_get=get, env=env)
    worker.ping_healthcheck(_ctx(), http_get=get, env=env)  # Web Push disabled
    healthy.round_error = True
    worker.ping_healthcheck(healthy, http_get=get, env=env)
    healthy.round_error, healthy.tick_crashed = False, True
    worker.ping_healthcheck(healthy, http_get=get, env=env)
    healthy.tick_crashed, healthy.degraded_reasons = False, ["vapid_subject_placeholder"]
    worker.ping_healthcheck(healthy, http_get=get, env=env)
    healthy.degraded_reasons, healthy.delivery_error = [], True
    worker.ping_healthcheck(healthy, http_get=get, env=env)
    healthy.delivery_error = False
    worker.ping_healthcheck(healthy, http_get=get, env=env, heartbeat_ok=False)  # Supabase rejects writes
    assert calls == [("https://hc.example/abc/", 5)] + [("https://hc.example/abc/fail", 5)] * 6


def test_a_rejected_heartbeat_write_pings_fail(monkeypatch):
    calls = []
    monkeypatch.setenv("HEALTHCHECK_URL", "https://hc.example/abc")
    monkeypatch.setattr("requests.get", lambda url, timeout: calls.append(url))
    ctx = worker.WorkerContext(None, SettingsDb(result=False), OnSender(), History(), lambda *a, **k: True)
    worker.report_tick(ctx, 1, 0)
    ctx.supabase = SettingsDb()
    worker.report_tick(ctx, 1, 0)
    assert calls == ["https://hc.example/abc/fail", "https://hc.example/abc"]


def test_a_failing_delivery_step_is_reported_until_a_clean_pass(monkeypatch, steps):
    def boom(*a, **k):
        raise RuntimeError("down")

    ctx = _ctx()
    monkeypatch.setattr(worker, "process_due_reminders", boom)
    worker.run_delivery_pass(ctx)
    assert ctx.delivery_error is True
    monkeypatch.setattr(worker, "process_due_reminders", lambda *a, **k: 0)
    worker.run_delivery_pass(ctx)
    assert ctx.delivery_error is False


def test_a_readable_login_poll_clears_a_failed_round(steps):
    ctx = _ctx(supabase=MarkerDb([], []))
    ctx.round_error = True
    ctx.last_tasks_check = 10 ** 12  # no full round due: only the login poll runs
    worker.run_tick(ctx)
    assert ctx.round_error is False


def test_the_healthcheck_is_optional_and_swallows_errors(capsys):
    def never(*a, **k):
        pytest.fail("no URL, no call")

    def down(url, timeout):
        raise OSError("unreachable https://hc.example/secret")

    worker.ping_healthcheck(_ctx(), http_get=never, env={})
    worker.ping_healthcheck(_ctx(), http_get=down, env={"HEALTHCHECK_URL": "https://hc.example/secret"})
    assert "secret" not in capsys.readouterr().out


# ---- startup checks -------------------------------------------------------------------------------------


class Configured:
    is_configured = True


class Unconfigured:
    is_configured = False


@pytest.mark.parametrize("supabase,sender,env,reason", [
    (Unconfigured(), OnSender(), {"VAPID_SUBJECT": "mailto:a@b.c"}, "supabase_not_configured"),
    (Configured(), OffSender(), {"VAPID_SUBJECT": "mailto:a@b.c"}, "webpush_disabled"),
    (Configured(), OnSender(), {}, "vapid_subject_placeholder"),
])
def test_each_startup_problem_is_reported_and_fatal_only_when_strict(supabase, sender, env, reason, capsys):
    assert worker.check_startup(supabase, sender, env) == [reason]
    out = capsys.readouterr().out
    assert "MODO DEGRADADO" in out and reason in out
    with pytest.raises(SystemExit) as info:
        worker.check_startup(supabase, sender, dict(env, WORKER_STRICT="1"))
    assert info.value.code == 1


def test_a_healthy_startup_reports_nothing(capsys):
    env = {"VAPID_SUBJECT": "mailto:a@b.c", "WORKER_STRICT": "1"}
    assert worker.check_startup(Configured(), OnSender(), env) == []
    assert capsys.readouterr().out == ""


# ---- single instance ------------------------------------------------------------------------------------


def test_a_second_lock_on_the_same_database_fails(tmp_path):
    path = str(tmp_path / "moodle_tasks.db.lock")
    first, second = worker.InstanceLock(path), worker.InstanceLock(path)
    assert first.acquire() is True
    try:
        assert second.acquire() is False
    finally:
        first.release()
    assert second.acquire() is True
    second.release()


def test_a_second_worker_exits_with_code_1(tmp_path, capsys):
    class Db:
        db_path = str(tmp_path / "moodle_tasks.db")

    held = worker.acquire_instance_lock(Db())
    try:
        with pytest.raises(SystemExit) as info:
            worker.acquire_instance_lock(Db())
        assert info.value.code == 1
        assert "otro worker" in capsys.readouterr().out
    finally:
        held.release()


# ---- startup hydration, VAPID key, daily prune ----------------------------------------------------------


def test_hydration_runs_when_the_storage_supports_it(capsys):
    class Hydrating:
        def __init__(self):
            self.calls = []

        def hydrate_from_remote(self, supabase):
            self.calls.append(supabase)
            return {"milestones": 3}

    class Broken:
        def hydrate_from_remote(self, supabase):
            raise RuntimeError("down")

    class Failed:
        def hydrate_from_remote(self, supabase):
            return {"error": "RuntimeError: HTTP 503"}

    store, db = Hydrating(), object()
    assert worker.hydrate_storage(store, db) is True
    assert store.calls == [db] and "milestones" in capsys.readouterr().out
    assert worker.hydrate_storage(object(), db) is True  # older storage: nothing to do
    assert worker.hydrate_storage(Broken(), db) is False  # never raises, asks for a retry
    assert worker.hydrate_storage(Failed(), db) is False


def test_a_failed_restore_is_retried_and_holds_the_moodle_round_back(monkeypatch, steps):
    results = [{"error": "down"}, {"error": "down"}, {"milestones": 4, "settings": 1}]

    class Store:
        def hydrate_from_remote(self, supabase):
            return results.pop(0)

    rounds = []
    monkeypatch.setattr(worker, "run_task_tick", lambda *a, **k: rounds.append(1) or "users")
    ctx = worker.WorkerContext(Store(), SettingsDb(), OffSender(), History(), lambda *a, **k: True, clock=Clock())
    ctx.hydrated = False
    worker.run_tick(ctx)
    worker.run_tick(ctx)
    assert rounds == [] and steps.count("process_class_reminders") == 2  # deliveries keep their cadence
    worker.run_tick(ctx)
    assert ctx.hydrated is True and rounds == [1]


def test_a_restore_that_never_succeeds_stops_holding_the_rounds_back(monkeypatch, steps, capsys):
    class Store:
        def hydrate_from_remote(self, supabase):
            return {"error": "down"}

    rounds = []
    monkeypatch.setattr(worker, "run_task_tick", lambda *a, **k: rounds.append(1) or "users")
    clock = Clock()
    ctx = worker.WorkerContext(Store(), SettingsDb(), OffSender(), History(), lambda *a, **k: True, clock=clock)
    ctx.hydrated = False
    worker.run_tick(ctx)
    clock.advance(worker.HYDRATION_MAX_WAIT_SECONDS + 1)
    ctx.last_tasks_check = 0
    worker.run_tick(ctx)
    assert rounds == [1] and "se revisa Moodle igualmente" in capsys.readouterr().out


def test_the_public_vapid_key_is_published_only_for_an_enabled_sender():
    db = SettingsDb()
    worker.publish_vapid_public_key(db, OnSender())
    worker.publish_vapid_public_key(db, OffSender())
    assert db.settings == [("vapid_public_key", "BPUB", False)]
    worker.publish_vapid_public_key(SettingsDb(fail=RuntimeError("x")), OnSender())  # never raises


def test_stale_class_keys_are_pruned_once_a_day():
    class Pruning:
        calls = 0

        def prune_stale_class_keys(self):
            Pruning.calls += 1
            return 2

    ctx = worker.WorkerContext(Pruning(), None, OffSender(), History(), lambda *a, **k: True)
    worker.prune_storage_if_due(ctx)
    worker.prune_storage_if_due(ctx)
    assert Pruning.calls == 1
    ctx.last_storage_prune_day = "2000-01-01"
    worker.prune_storage_if_due(ctx)
    assert Pruning.calls == 2


def test_run_worker_reports_a_degraded_start_in_the_heartbeat(monkeypatch, tmp_path):
    class Db(SettingsDb):
        def fetch_active_users(self):
            return []

        def insert_notification_log(self, rows):
            pass

        def prune_notification_log(self, cutoff):
            pass

    class Offline:
        is_configured, url = False, ""

    db = Db()
    storage = Storage(str(tmp_path / "t.db"))
    storage.supabase = Offline()
    monkeypatch.setattr(worker, "Storage", lambda: storage)
    monkeypatch.setattr(worker.SupabaseClient, "for_worker", classmethod(lambda cls: db))
    monkeypatch.setattr(worker.WebPushSender, "from_env", classmethod(lambda cls, sb: OffSender()))
    for name in ("process_class_reminders", "check_and_notify_upcoming_classes", "process_due_reminders",
                 "process_push_tests"):
        monkeypatch.setattr(worker, name, lambda *a, **k: 0)
    stop = threading.Event()
    monkeypatch.setattr(worker, "report_tick", lambda ctx, *a: (seen.append(list(ctx.degraded_reasons)), stop.set()))
    seen = []
    worker.run_worker(stop_event=stop, tick_seconds=0)
    assert seen == [["webpush_disabled"]]
    # the lock was released: a new worker could start
    assert worker.InstanceLock(f"{storage.db_path}.lock").acquire() is True
