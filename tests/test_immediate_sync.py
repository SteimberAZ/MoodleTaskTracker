from worker import remember_logins, run_task_tick, users_needing_immediate_sync


def _user(uid, login):
    return {"id": uid, "last_login_at": login, "ntfy_topic": "utm-x", "token": "t"}


def test_new_user_needs_immediate_sync():
    users = [_user("a", "2026-10-08T05:50:41Z")]
    assert users_needing_immediate_sync(users, {}) == users


def test_already_synced_login_is_skipped():
    seen = {"a": "2026-10-08T05:50:41Z"}
    assert users_needing_immediate_sync([_user("a", "2026-10-08T05:50:41Z")], seen) == []


def test_relogin_triggers_sync_again():
    seen = {"a": "2026-10-08T05:50:41Z"}
    users = [_user("a", "2026-10-08T07:00:00Z"), _user("b", None)]
    seen["b"] = ""
    assert [u["id"] for u in users_needing_immediate_sync(users, seen)] == ["a"]


def test_rows_without_id_are_ignored():
    assert users_needing_immediate_sync([{"id": None, "last_login_at": "x"}], {}) == []


def test_remember_logins_records_each_user():
    seen = {}
    remember_logins([_user("a", "L1"), _user("b", None)], seen)
    assert seen == {"a": "L1", "b": ""}


class _FakeSupabase:
    def __init__(self, users):
        self._users = users

    def fetch_active_users(self):
        return self._users


def test_full_round_remembers_synced_users(monkeypatch):
    import worker

    monkeypatch.setattr(worker, "sync_all_users", lambda *a, **k: {})
    seen = {}
    mode = run_task_tick(None, _FakeSupabase([_user("a", "L1")]), seen_logins=seen)
    assert mode == "users"
    assert seen == {"a": "L1"}
