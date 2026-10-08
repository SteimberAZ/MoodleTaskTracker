"""pkg-worker-data: Storage milestones, change-only task mirror, deadline re-arm, hydration and pruning."""
import time

import storage as storage_mod
import supabase_client
from storage import Storage, milestones_to_rearm
from supabase_client import SupabaseClient

H = 3600


class _Resp:
    def __init__(self, status=201, text=""):
        self.status_code = status
        self.text = text


class FakeMirror:
    """Stands in for SupabaseClient: records every remote write."""

    is_configured = True

    def __init__(self, task_result=True, milestone_result=None):
        self.task_batches = []
        self.milestones = []
        self.deleted = []
        self.settings = []
        self.task_result = task_result
        self.milestone_result = milestone_result

    def upsert_tasks(self, tasks, async_call=True):
        self.task_batches.append([dict(t) for t in tasks])
        return self.task_result

    def upsert_milestone(self, task_id, milestone, sent_at, async_call=True):
        self.milestones.append((task_id, milestone))
        return self.milestone_result

    def delete_milestones(self, task_id, keys):
        self.deleted.append((task_id, sorted(keys)))
        return True

    def upsert_setting(self, key, value, async_call=True):
        self.settings.append(key)
        return True


def _storage(tmp_path, mirror=None):
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = mirror if mirror is not None else FakeMirror()
    return s


def _task(tid="t1", hours_left=20.0, **extra):
    t = {"id": tid, "title": "Tarea", "course": "Curso", "user_id": "u1", "status": "pending",
         "due_timestamp": int(time.time() + hours_left * H), "description": "d", "teachers": ["Ana"],
         "details_updated_at": "2026-10-01T00:00:00+00:00"}
    t.update(extra)
    return t


# ---- record_milestone ------------------------------------------------------------------------------


def test_record_milestone_twice_makes_one_remote_call_with_ignore_duplicates(tmp_path, monkeypatch):
    posts = []
    monkeypatch.setattr(supabase_client.requests, "post",
                        lambda url, json=None, headers=None, timeout=None: posts.append((url, headers["Prefer"])) or _Resp())
    monkeypatch.setattr(SupabaseClient, "_run", lambda self, work, async_call: work())
    s = Storage(str(tmp_path / "t.db"))
    s.supabase = SupabaseClient(url="https://sb.example", key="k")
    s.record_milestone("t1", "1d")
    s.record_milestone("t1", "1d")
    assert posts == [("https://sb.example/rest/v1/moodle_task_milestones?on_conflict=task_id,milestone",
                      "resolution=ignore-duplicates,return=minimal")]


def test_a_synchronous_mirror_failure_is_deferred_and_flushed_later(tmp_path):
    mirror = FakeMirror(milestone_result=False)
    s = _storage(tmp_path, mirror)
    s.record_milestone("t1", "new")
    assert list(s._deferred_milestones) and s._deferred_milestones[0][:2] == ("t1", "new")
    mirror.milestone_result = None
    s.save_tasks([_task("t1")])  # a successful task mirror flushes the queue
    assert mirror.milestones == [("t1", "new"), ("t1", "new")] and not s._deferred_milestones


def test_local_only_milestones_are_never_mirrored(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.record_milestone("class:c1:2026-10-06", "sent", mirror=False)
    assert mirror.milestones == [] and s.has_notified_milestone("class:c1:2026-10-06", "sent")


# ---- change-only task mirror -----------------------------------------------------------------------


def test_an_unchanged_resave_mirrors_nothing_and_a_change_mirrors_one_row(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1"), _task("t2")])
    assert [len(b) for b in mirror.task_batches] == [2]

    s.save_tasks([_task("t1"), _task("t2")])
    assert [len(b) for b in mirror.task_batches] == [2]  # no remote write
    assert s.last_task_mirror_ok is True

    s.save_tasks([_task("t1", title="Renamed"), _task("t2")])
    assert [len(b) for b in mirror.task_batches] == [2, 1]
    assert mirror.task_batches[-1][0]["id"] == "t1"
    assert not any(k.startswith("last_full_task_mirror_at") for k in mirror.settings)  # local only


def test_every_task_is_resent_after_a_failed_mirror(tmp_path):
    mirror = FakeMirror(task_result=False)
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1"), _task("t2")])
    mirror.task_result = True
    s.save_tasks([_task("t1"), _task("t2")])
    assert [len(b) for b in mirror.task_batches] == [2, 2]


def test_a_full_remirror_runs_once_a_day(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1")])
    s.set_setting("last_full_task_mirror_at:u1", str(int(time.time()) - storage_mod.FULL_TASK_MIRROR_EVERY - 1))
    s.save_tasks([_task("t1")])
    assert [len(b) for b in mirror.task_batches] == [1, 1]
    s.save_tasks([_task("t1")])
    assert len(mirror.task_batches) == 2


def test_a_task_that_returns_unchanged_after_an_absence_is_resent(tmp_path):
    # While absent it may have been flagged missing_since remotely; re-sending it clears the flag.
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1"), _task("t2")])
    s.save_tasks([_task("t1")])  # t2 not returned this round
    assert [len(b) for b in mirror.task_batches] == [2]
    s.save_tasks([_task("t1"), _task("t2")])
    assert [[t["id"] for t in b] for b in mirror.task_batches] == [["t1", "t2"], ["t2"]]
    s.save_tasks([_task("t1"), _task("t2")])
    assert len(mirror.task_batches) == 2


def test_unchanged_details_keep_their_first_timestamp(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1", details_updated_at="2026-10-01T00:00:00+00:00")])
    again = _task("t1", details_updated_at="2026-10-08T00:00:00+00:00")
    s.save_tasks([again])
    assert again["details_updated_at"] == "2026-10-01T00:00:00+00:00"
    assert len(mirror.task_batches) == 1

    changed = _task("t1", description="new text", details_updated_at="2026-10-09T00:00:00+00:00")
    s.save_tasks([changed])
    assert changed["details_updated_at"] == "2026-10-09T00:00:00+00:00"
    assert mirror.task_batches[-1][0]["description"] == "new text"


# ---- deadline extension ----------------------------------------------------------------------------


def _with_sent(s, *milestones, tid="t1"):
    for m in milestones:
        s.record_milestone(tid, m)


def test_extending_a_deadline_rearms_the_larger_milestones(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1", hours_left=20)])
    _with_sent(s, "new", "1d", "2d", "3d")  # what the notifier records 20 h before the deadline
    s.save_tasks([_task("t1", hours_left=70)])
    assert [m for m in ("new", "8h", "1d", "2d", "3d") if s.has_notified_milestone("t1", m)] == ["new"]
    assert mirror.deleted == [("t1", ["1d", "2d", "3d"])]


def test_a_shift_inside_the_current_window_deletes_nothing(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1", hours_left=20)])
    _with_sent(s, "new", "1d", "2d", "3d")
    s.save_tasks([_task("t1", hours_left=22)])
    assert all(s.has_notified_milestone("t1", m) for m in ("new", "1d", "2d", "3d"))
    assert mirror.deleted == []


def test_an_earlier_deadline_deletes_nothing(tmp_path):
    mirror = FakeMirror()
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1", hours_left=70)])
    _with_sent(s, "new", "3d")
    s.save_tasks([_task("t1", hours_left=20)])
    assert s.has_notified_milestone("t1", "3d") and mirror.deleted == []


def test_milestones_to_rearm_rules():
    now = 1_000_000
    assert milestones_to_rearm(now + 20 * H, now + 70 * H, now) == ["8h", "1d", "2d", "3d"]
    assert milestones_to_rearm(now + 20 * H, now + 22 * H, now) == ["8h"]  # only the future 8h window
    assert milestones_to_rearm(now + 5 * H, now + 100 * H, now) == ["8h", "1d", "2d", "3d"]
    assert milestones_to_rearm(now + 70 * H, now + 20 * H, now) == []
    assert milestones_to_rearm(0, now + 20 * H, now) == []


def test_rearmed_milestones_leave_the_deferred_queue(tmp_path):
    mirror = FakeMirror(task_result=False)
    s = _storage(tmp_path, mirror)
    s.save_tasks([_task("t1", hours_left=20)])
    _with_sent(s, "new", "1d")
    assert [m[1] for m in s._deferred_milestones] == ["new", "1d"]
    s.save_tasks([_task("t1", hours_left=70)])
    assert [m[1] for m in s._deferred_milestones] == ["new"]


def test_a_failed_milestone_mirror_is_deferred_not_lost(tmp_path):
    class Flaky(FakeMirror):
        def upsert_milestone(self, task_id, milestone, sent_at, async_call=True):
            self.milestones.append((task_id, milestone, async_call))
            return self.milestone_result

    mirror = Flaky(milestone_result=False)  # e.g. the 5 s write timed out
    s = _storage(tmp_path, mirror)
    s.record_milestone("t1", "1d")
    assert mirror.milestones == [("t1", "1d", False)]  # synchronous: its result is read
    assert [m[:2] for m in s._deferred_milestones] == [("t1", "1d")]
    s._flush_deferred_milestones()  # still failing: kept for the next flush
    assert [m[:2] for m in s._deferred_milestones] == [("t1", "1d")]
    mirror.milestone_result = True
    s._flush_deferred_milestones()
    assert not s._deferred_milestones and mirror.milestones[-1] == ("t1", "1d", False)


# ---- hydration -------------------------------------------------------------------------------------


class RemoteState:
    is_configured = True

    def __init__(self, fail=False):
        self.fail = fail
        self.reads = 0

    def fetch_milestones_since(self, days=14):
        self.reads += 1
        if self.fail:
            raise RuntimeError("HTTP 503")
        return [{"task_id": "t1", "milestone": "new", "sent_at": 100},
                {"task_id": "t1", "milestone": "1d", "sent_at": 200}]

    def fetch_settings_like(self, prefix):
        return {
            "api_migration_done": [{"key": "api_migration_done:u1", "value": "1"}],
            "api_token_alert_fingerprint": [{"key": "api_token_alert_fingerprint:u1", "value": "fp"}],
        }[prefix]


def test_hydration_fills_an_empty_database_once(tmp_path):
    s = _storage(tmp_path)
    remote = RemoteState()
    assert s.hydrate_from_remote(remote) == {"milestones": 2, "settings": 2}
    assert s.has_notified_milestone("t1", "new") and s.has_notified_milestone("t1", "1d")
    assert s.get_setting("api_migration_done:u1") == "1"
    assert s.get_setting("api_token_alert_fingerprint:u1") == "fp"
    assert s.supabase.milestones == [] and s.supabase.settings == []  # restored locally, not re-mirrored

    second = s.hydrate_from_remote(remote)
    assert second["skipped"] == "local_state_present" and remote.reads == 1


def test_hydration_still_runs_when_only_class_reminder_keys_exist(tmp_path):
    s = _storage(tmp_path)
    # The delivery pass of the first ticks records class keys before a failed restore is retried.
    s.record_milestone("class:abc:2026-10-08", "30m")
    s.record_milestone("class_7_2026-10-08", "30m")
    remote = RemoteState()
    assert s.hydrate_from_remote(remote) == {"milestones": 2, "settings": 2}
    assert s.has_notified_milestone("t1", "1d")


def test_hydration_failure_is_reported_not_raised(tmp_path):
    s = _storage(tmp_path)
    result = s.hydrate_from_remote(RemoteState(fail=True))
    assert result == {"error": "RuntimeError: HTTP 503"}
    assert not s.has_notified_milestone("t1", "new")


def test_hydration_without_a_database_is_skipped(tmp_path):
    s = _storage(tmp_path)
    remote = RemoteState()
    remote.is_configured = False
    assert s.hydrate_from_remote(remote)["skipped"] == "not_configured"


# ---- pruning ---------------------------------------------------------------------------------------


def test_prune_stale_class_keys(tmp_path):
    s = _storage(tmp_path)
    old = int(time.time()) - 20 * 86400
    with s._get_conn() as conn:
        conn.executemany(
            "INSERT INTO task_milestones (task_id, milestone, sent_at) VALUES (?, ?, ?)",
            [("class:c1:2026-09-01", "sent", old), ("class_web_mar_2026-09-01", "30m", old),
             ("class:c1:2026-10-08", "sent", int(time.time())), ("abc123", "new", old)],
        )
        conn.commit()
    assert s.prune_stale_class_keys(14) == 2
    assert s.has_notified_milestone("class:c1:2026-10-08", "sent")
    assert s.has_notified_milestone("abc123", "new")  # task milestones are never pruned
    assert not s.has_notified_milestone("class:c1:2026-09-01", "sent")
