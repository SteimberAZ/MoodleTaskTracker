"""Worker loop: delivery cadence, round budget, stop handling, crash survival and the login poll."""
import signal
import threading

import pytest

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
    assert ctx.round_error is True
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
    monkeypatch.setattr(worker, "process_class_reminders",
                        lambda st, sb, deliver: deliver({"id": UID, "ntfy_topic": ""}, "Clase", "Hoy", kind="class"))
    for name in ("check_and_notify_upcoming_classes", "process_due_reminders", "process_push_tests"):
        monkeypatch.setattr(worker, name, lambda *a, **k: 0)
    rounds = []

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
