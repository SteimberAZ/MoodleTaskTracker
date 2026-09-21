import os
import threading
from typing import Dict, List, Optional
import requests


def _load_env_file():
    """Carga variables desde .env si existe sin requerir dependencias externas."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(base_dir, ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    except Exception:
        pass


_load_env_file()


class SupabaseClient:
    """Cliente ligero para sincronizar datos con Supabase vía REST API."""

    def __init__(self, url: Optional[str] = None, key: Optional[str] = None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self.key = key or os.environ.get("SUPABASE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")

    @property
    def is_configured(self) -> bool:
        return bool(self.url and self.key)

    def _headers(self) -> Dict[str, str]:
        return {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        }

    def upsert_tasks(self, tasks: List[Dict], async_call: bool = True):
        """Inserta o actualiza tareas en la tabla moodle_tasks de Supabase."""
        if not self.is_configured or not tasks:
            return

        def _do_upsert():
            try:
                payload = []
                for t in tasks:
                    payload.append({
                        "id": str(t["id"]),
                        "title": t["title"],
                        "course": t.get("course", "Materia no especificada"),
                        "due_date_str": t.get("due_date_str", ""),
                        "due_timestamp": t.get("due_timestamp", 0),
                        "task_url": t.get("task_url", ""),
                        "status": t.get("status", "pending"),
                        "first_seen": t.get("first_seen", 0),
                        "last_updated": t.get("last_updated", 0),
                        "is_notified": t.get("is_notified", 0),
                        "is_dismissed": t.get("is_dismissed", 0),
                    })

                endpoint = f"{self.url}/rest/v1/moodle_tasks"
                requests.post(endpoint, json=payload, headers=self._headers(), timeout=5)
            except Exception:
                pass

        if async_call:
            threading.Thread(target=_do_upsert, daemon=True).start()
        else:
            _do_upsert()

    def upsert_milestone(self, task_id: str, milestone: str, sent_at: int, async_call: bool = True):
        """Registra un hito en la tabla moodle_task_milestones de Supabase."""
        if not self.is_configured:
            return

        def _do_upsert():
            try:
                endpoint = f"{self.url}/rest/v1/moodle_task_milestones"
                payload = {
                    "task_id": str(task_id),
                    "milestone": str(milestone),
                    "sent_at": sent_at,
                }
                requests.post(endpoint, json=payload, headers=self._headers(), timeout=5)
            except Exception:
                pass

        if async_call:
            threading.Thread(target=_do_upsert, daemon=True).start()
        else:
            _do_upsert()

    def upsert_setting(self, key: str, value: str, async_call: bool = True):
        """Sincroniza un ajuste en moodle_settings."""
        if not self.is_configured:
            return

        def _do_upsert():
            try:
                endpoint = f"{self.url}/rest/v1/moodle_settings"
                payload = {"key": str(key), "value": str(value)}
                requests.post(endpoint, json=payload, headers=self._headers(), timeout=5)
            except Exception:
                pass

        if async_call:
            threading.Thread(target=_do_upsert, daemon=True).start()
        else:
            _do_upsert()

    def fetch_tasks(self) -> List[Dict]:
        """Recupera todas las tareas registradas en la nube."""
        if not self.is_configured:
            return []
        try:
            endpoint = f"{self.url}/rest/v1/moodle_tasks?select=*&order=due_timestamp.asc"
            r = requests.get(endpoint, headers=self._headers(), timeout=8)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return []
