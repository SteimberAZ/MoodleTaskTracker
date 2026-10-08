import supabase_client
from storage import Storage
from supabase_client import SupabaseClient


class _Resp:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self._payload = payload if payload is not None else []
        self.text = ""

    def json(self):
        return self._payload


def test_key_prefers_service_role_then_supabase_key(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://sb.example")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    monkeypatch.setenv("SUPABASE_KEY", "legacy")
    assert SupabaseClient.for_service_role().key == "service"
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    assert SupabaseClient.for_service_role().key == "legacy"


def test_reminders_use_prefixed_table(monkeypatch):
    calls = []

    def fake_get(url, **kw):
        calls.append(("get", url, kw["headers"]))
        return _Resp(200, [])

    def fake_patch(url, **kw):
        calls.append(("patch", url, kw["headers"]))
        return _Resp(204)

    monkeypatch.setattr(supabase_client.requests, "get", fake_get)
    monkeypatch.setattr(supabase_client.requests, "patch", fake_patch)
    c = SupabaseClient(url="https://sb.example", key="service")
    c.fetch_due_reminders("2026-01-01T00:00:00+00:00")
    c.update_reminder("r1", {"active": False})
    assert [u for _, u, _ in calls] == [
        "https://sb.example/rest/v1/moodle_custom_reminders",
        "https://sb.example/rest/v1/moodle_custom_reminders",
    ]
    assert all(h["Authorization"] == "Bearer service" for _, _, h in calls)


def test_cookie_setting_is_not_mirrored_to_supabase(tmp_path):
    class Recorder:
        is_configured = True

        def __init__(self):
            self.keys = []

        def upsert_setting(self, key, value):
            self.keys.append(key)

    s = Storage(str(tmp_path / "t.db"))
    s.supabase = Recorder()
    s.set_setting("moodle_session", "secret-cookie")
    s.set_setting("check_interval_mins", "15")
    assert s.supabase.keys == ["check_interval_mins"]
    assert s.get_setting("moodle_session") == "secret-cookie"
