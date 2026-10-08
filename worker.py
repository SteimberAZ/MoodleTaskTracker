"""Headless multi-user worker: Moodle task sync plus every time-critical delivery.

One tick per ``TICK_SECONDS``. Each tick starts with the delivery pass (class reminders, custom
reminders, Web Push tests, then the notification history), so those keep their cadence however slow
Moodle is: during a long Moodle round the pass also runs between users, at most once per
``DELIVERY_INTERVAL_SECONDS``. A round has a wall-clock budget; users it did not reach go first next
round. SIGINT/SIGTERM stop the loop at a step boundary, and an unexpected exception in a tick is
logged and survived.

Health: every tick ends with a heartbeat in moodle_settings ``worker_status`` (JSON, see
``build_heartbeat``) and, when ``HEALTHCHECK_URL`` is set, a dead-man-switch ping. A long Moodle
round also reports between users, at most once per ``HEARTBEAT_INTERVAL_SECONDS``, so the web never
sees a healthy worker as stopped; one more report goes out right after the startup checks. A missing
Supabase config, a disabled Web Push sender or the placeholder VAPID subject are reported loudly at
startup and in every heartbeat (``degraded``); ``WORKER_STRICT=1`` makes them fatal instead. Only one
worker may run per database: a second one exits with code 1.
"""
import inspect
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote, urlparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from notifier import mask_topic, ntfy_base_url
from storage import Storage
from class_reminders import process_class_reminders
from class_schedule import check_and_notify_upcoming_classes
from custom_reminders import process_due_reminders
from delivery import deliver_to_user, process_push_tests
from notification_log import NotificationLog
from supabase_client import SupabaseClient
from api_sync import CircuitBreaker, sync_user_via_api
from webpush_sender import TTL_REMINDER, WebPushSender, resolve_subject

TICK_SECONDS = 60
# The delivery pass runs at most this often between the users of a long Moodle round.
DELIVERY_INTERVAL_SECONDS = 60
# Wall-clock budget of one Moodle round; users not reached go first in the next round.
ROUND_BUDGET_SECONDS = 600
# Pause between two users of a round (politeness towards Moodle).
USER_PAUSE_SECONDS = 0.5

WORKER_VERSION = "1.0"  # reported when the git revision cannot be read
WORKER_STATUS_KEY = "worker_status"
VAPID_PUBLIC_KEY_SETTING = "vapid_public_key"
HEALTHCHECK_TIMEOUT_SECONDS = 5
# During a long Moodle round the heartbeat (and the ping) are refreshed at most this often, well below
# the web's WORKER_STALE_SECONDS (180 s).
HEARTBEAT_INTERVAL_SECONDS = 60
# A failed startup restore from Supabase is retried every tick and holds the Moodle rounds back (they
# would re-announce every milestone on a fresh SQLite file) for at most this long.
HYDRATION_MAX_WAIT_SECONDS = 15 * 60

# Startup problems that leave the worker running in a degraded mode (fatal with WORKER_STRICT=1).
DEGRADED_MESSAGES = {
    "supabase_not_configured": "Supabase no está configurado (SUPABASE_URL / MOODLE_DB_JWT): no hay usuarios, "
                               "recordatorios ni historial; solo SQLite local.",
    "webpush_disabled": "Web Push está desactivado: nadie recibe notificaciones nativas (solo ntfy).",
    "vapid_subject_placeholder": "VAPID_SUBJECT no está definido: se usa mailto:admin@localhost y algunos "
                                 "servicios de push pueden rechazar los envíos.",
}

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL_RE = re.compile(r"https?://\S+")
_LOGGED_ONCE: Dict[str, str] = {}


def _stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _user_id(user: Dict) -> str:
    return str(user.get("id") or "")


def _log_on_change(key: str, message: Optional[str]) -> None:
    """Print ``message`` only when it differs from the last one for ``key`` (no per-tick log spam)."""
    if _LOGGED_ONCE.get(key) != (message or ""):
        _LOGGED_ONCE[key] = message or ""
        if message:
            print(message)


def _scrub(text: Any, limit: int = 200) -> str:
    """Status text safe to publish: e-mail addresses and URLs (push endpoints) removed, clipped."""
    cleaned = _URL_RE.sub("<url>", _EMAIL_RE.sub("<email>", str(text or "")))
    return " ".join(cleaned.split())[:limit]


class RoundPlanner:
    """Order of the users of each round: users the previous round did not reach go first, then the
    rest in an order that rotates every round, so nobody is always last when the budget runs out."""

    def __init__(self):
        self.carry: List[str] = []
        self.offset = 0

    def order(self, users: List[Dict]) -> List[Dict]:
        carried = set(self.carry)
        by_id = {_user_id(u): u for u in users}
        first = [by_id[i] for i in self.carry if i in by_id]
        rest = [u for u in users if _user_id(u) not in carried]
        if rest:
            k = self.offset % len(rest)
            rest = rest[k:] + rest[:k]
        self.offset += 1
        return first + rest

    def record(self, ordered: List[Dict], outcomes: Dict[str, str]) -> None:
        self.carry = [_user_id(u) for u in ordered if outcomes.get(_user_id(u)) == "deferred"]


def _run_hook(hook: Optional[Callable[[], Any]], name: str) -> None:
    if hook is None:
        return
    try:
        hook()
    except Exception as err:  # noqa: BLE001 - a hook must never break the round
        print(f"[Worker] [!] {name} failed: {type(err).__name__}: {err}")


def sync_all_users(
    storage,
    supabase,
    users: List[Dict],
    client_factory: Optional[Callable[[Dict], Any]] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
    deliver: Optional[Callable] = None,
    after_user: Optional[Callable[[], Any]] = None,
    between_users: Optional[Callable[[], Any]] = None,
    budget_seconds: Optional[float] = None,
    pause_seconds: float = 0.0,
    stop_event: Optional[threading.Event] = None,
    breaker: Optional[CircuitBreaker] = None,
    clock: Callable[[], float] = time.monotonic,
) -> Dict[str, str]:
    """Sync every user in isolation: one user's failure never blocks the others.

    Returns {user_id: "ok" | "invalid" | "error" | "skipped" | "deferred"}. Notifications of a user
    only go to that user's own channels (``deliver``: Web Push + their ntfy topic; without it, ntfy
    only); a user without a topic is skipped (never falls back to the owner's). ``after_user`` runs
    after each synced user (the worker writes the notification history there) and ``between_users``
    before every user but the first (the worker's throttled delivery pass); neither may break the
    round. Users are "deferred" (not attempted) once ``stop_event`` is set, ``budget_seconds`` ran
    out, or the circuit ``breaker`` tripped after consecutive Moodle network errors.
    """
    breaker = breaker if breaker is not None else CircuitBreaker()
    started = clock()
    outcomes: Dict[str, str] = {}
    attempted = 0
    for index, user in enumerate(users):
        user_id = _user_id(user)
        topic = str(user.get("ntfy_topic") or "").strip()
        tag = f"user {user_id[:8]} ({mask_topic(topic)})"
        if not user_id or not topic or not str(user.get("token") or "").strip():
            print(f"[Worker] {tag}: incomplete user row (id/topic/token); skipped.")
            outcomes[user_id] = "skipped"
            continue
        if attempted:
            _run_hook(between_users, "between-users hook")
            if pause_seconds:
                if stop_event is not None:
                    stop_event.wait(pause_seconds)
                else:
                    time.sleep(pause_seconds)
        reason = None
        if stop_event is not None and stop_event.is_set():
            reason = "stop requested"
        elif budget_seconds is not None and clock() - started >= budget_seconds:
            reason = f"round budget of {int(budget_seconds)} s used up"
        elif breaker.tripped:
            reason = f"Moodle unreachable ({breaker.failures} network errors in a row)"
        if reason:
            rest = [_user_id(u) for u in users[index:] if _user_id(u)]
            for rest_id in rest:
                outcomes.setdefault(rest_id, "deferred")
            print(f"[Worker] [!] {reason}: {len(rest)} user(s) left for the next round.")
            break
        attempted += 1
        try:
            client = client_factory(user) if client_factory else None
            outcomes[user_id] = sync_user_via_api(
                storage, user, supabase, client=client, process=process, alert=alert, deliver=deliver,
                breaker=breaker,
            )
        except Exception as err:  # sync_user_via_api never raises; belt and braces
            print(f"[Worker] {tag}: unexpected error: {err}")
            outcomes[user_id] = "error"
        print(f"[Worker] {tag}: {outcomes[user_id]}")
        _run_hook(after_user, "after-user hook")
    return outcomes


def users_needing_immediate_sync(users: List[Dict], seen_logins: Dict[str, str]) -> List[Dict]:
    """Users that logged in (or registered) since the worker last synced them.

    A login refreshes the Moodle token, so a new user or a new ``last_login_at`` gets synced on the
    next tick instead of waiting for the regular round.
    """
    return [
        u
        for u in users
        if str(u.get("id") or "") and seen_logins.get(str(u.get("id"))) != str(u.get("last_login_at") or "")
    ]


def remember_logins(users: List[Dict], seen_logins: Dict[str, str]) -> None:
    for u in users:
        if u.get("id"):
            seen_logins[str(u["id"])] = str(u.get("last_login_at") or "")


def _reached(users: List[Dict], outcomes: Dict[str, str]) -> List[Dict]:
    return [u for u in users if outcomes.get(_user_id(u)) != "deferred"]


def run_task_tick(
    storage,
    supabase,
    *,
    client_factory: Optional[Callable[[Dict], Any]] = None,
    process: Optional[Callable] = None,
    alert: Optional[Callable] = None,
    seen_logins: Optional[Dict[str, str]] = None,
    deliver: Optional[Callable] = None,
    after_user: Optional[Callable[[], Any]] = None,
    between_users: Optional[Callable[[], Any]] = None,
    planner: Optional[RoundPlanner] = None,
    stats: Optional[Dict[str, Any]] = None,
    budget_seconds: Optional[float] = None,
    pause_seconds: float = 0.0,
    stop_event: Optional[threading.Event] = None,
) -> str:
    """One task-sync round. Returns which path ran: "users" or "skipped".

    * active users with tokens exist -> sync each of them (``planner`` orders them);
    * the users table is empty -> loud warning, nothing to sync (there is no legacy fallback);
    * the users fetch failed -> skip the round (``stats["error"]`` is set).

    ``stats`` (optional) receives users_ok, users_err, users_deferred and error.
    """
    if stats is not None:
        stats.update(users_ok=0, users_err=0, users_deferred=0, error=False)
    try:
        users = supabase.fetch_active_users()
    except Exception as err:
        print(f"[Worker] [!] No se pudo leer moodle_users ({err}); se omite esta revisión (sin respaldo legacy).")
        if stats is not None:
            stats["error"] = True
        return "skipped"
    if not users:
        print("[Worker] ⚠️ ⚠️ No hay usuarios activos con token de Moodle (no active users): "
              "no se sincroniza ninguna tarea. Inicia sesión en la web para registrar tu cuenta.")
        return "skipped"
    print(f"[Worker] 👥 Usuarios activos: {len(users)}")
    ordered = planner.order(users) if planner is not None else users
    outcomes = sync_all_users(
        storage, supabase, ordered, client_factory=client_factory, process=process, alert=alert, deliver=deliver,
        after_user=after_user, between_users=between_users, budget_seconds=budget_seconds,
        pause_seconds=pause_seconds, stop_event=stop_event,
    )
    if planner is not None:
        planner.record(ordered, outcomes)
    if seen_logins is not None:
        remember_logins(_reached(ordered, outcomes), seen_logins)
    if stats is not None:
        values = list(outcomes.values())
        stats.update(
            users_ok=values.count("ok"),
            users_err=values.count("error") + values.count("invalid"),
            users_deferred=values.count("deferred"),
        )
    return "users"


def _accepts_keyword(fn: Callable, name: str) -> bool:
    """True when ``fn`` takes the keyword ``name`` (or ``**kwargs``); False when it cannot be told."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(p.name == name or p.kind is inspect.Parameter.VAR_KEYWORD for p in params)


def reminder_deliverer(deliver: Callable) -> Callable[[Dict, Dict, str, str], bool]:
    """Adapter for ``process_due_reminders``: one reminder -> every channel of its owner.

    The tag is per reminder, so a repeating reminder replaces its previous notification instead of
    stacking a new one every few minutes; ``renotify`` (when the deliverer supports it) makes that
    replacement alert again. A reminder linked to a task opens that task.
    """
    extra = {"renotify": True} if _accepts_keyword(deliver, "renotify") else {}

    def send(owner: Dict, reminder: Dict, title: str, body: str) -> bool:
        task_id = reminder.get("task_id")
        return deliver(
            owner,
            title,
            body,
            url=f"/tareas/{quote(str(task_id), safe='')}" if task_id else "/",
            tag=f"reminder-{reminder.get('id')}",
            priority="high",
            ttl=TTL_REMINDER,
            ntfy_tags="alarm_clock,bell",
            kind="reminder",
            **extra,
        )

    return send


class WorkerContext:
    """Everything one worker process shares between ticks."""

    def __init__(self, storage, supabase, sender, history, deliver: Callable,
                 stop_event: Optional[threading.Event] = None, tasks_check_seconds: float = 30 * 60,
                 clock: Callable[[], float] = time.monotonic):
        self.storage = storage
        self.supabase = supabase
        self.sender = sender
        self.history = history
        self.deliver = deliver
        self.stop_event = stop_event if stop_event is not None else threading.Event()
        self.tasks_check_seconds = tasks_check_seconds
        self.clock = clock
        self.planner = RoundPlanner()
        self.seen_logins: Dict[str, str] = {}  # user id -> last_login_at already synced
        self.last_tasks_check = 0.0  # wall clock of the last full round start
        self.last_delivery_at: Optional[float] = None  # monotonic start of the last delivery pass
        self.max_delivery_gap = 0.0  # longest gap between two delivery passes since the last report
        self.last_round_mode = "skipped"  # "users" | "skipped"
        self.users_ok = 0
        self.users_err = 0
        self.round_error = False  # the latest users read (full round or login poll) failed
        self.tick_crashed = False  # the current tick raised an unexpected exception
        self.delivery_error = False  # a step of the latest delivery pass raised
        self.hydrated = True  # False while the startup restore from Supabase is still pending
        self.hydration_deadline: Optional[float] = None  # monotonic time the rounds stop waiting for it
        self.tick_started: Optional[float] = None  # monotonic start of the current tick
        self.sync_started: Optional[float] = None  # monotonic start of the current Moodle sync
        self.last_report_at: Optional[float] = None  # monotonic time of the last heartbeat
        self.version = WORKER_VERSION
        self.degraded_reasons: List[str] = []  # startup problems (see DEGRADED_MESSAGES)
        self.last_push_ok_at: Optional[str] = None  # latest successful push seen by the sender stats
        self.last_storage_prune_day: Optional[str] = None

    @property
    def stopping(self) -> bool:
        return self.stop_event.is_set()

    def delivery_if_due(self) -> None:
        """Between two users: the delivery pass, when ``DELIVERY_INTERVAL_SECONDS`` passed since the
        last one, then the heartbeat, when ``HEARTBEAT_INTERVAL_SECONDS`` passed since the last one."""
        if self.last_delivery_at is None or self.clock() - self.last_delivery_at >= DELIVERY_INTERVAL_SECONDS:
            run_delivery_pass(self)
        report_if_due(self)


def _flush_history(ctx: WorkerContext) -> None:
    try:
        ctx.history.flush()
    except Exception as err:  # noqa: BLE001 - flush never raises; belt and braces
        print(f"[{_stamp()}] [!] Error al guardar el historial de avisos: {err}")


def run_delivery_pass(ctx: WorkerContext) -> None:
    """Every time-critical delivery, then the notification history. Each step is isolated.

    A stop request is honoured between steps (never inside one, so a delivery and its history
    record stay together), and the history is always flushed.
    """
    now = ctx.clock()
    if ctx.last_delivery_at is not None:
        ctx.max_delivery_gap = max(ctx.max_delivery_gap, now - ctx.last_delivery_at)
    ctx.last_delivery_at = now
    ctx.delivery_error = False
    steps = (
        # Each user's imported schedule (moodle_class_schedule) and lead time
        ("recordatorios de clases importadas", lambda: process_class_reminders(ctx.storage, ctx.supabase, ctx.deliver)),
        # Built-in owner schedule, only for admins without an imported one (env NTFY_TOPIC as fallback)
        ("recordatorio de clases",
         lambda: check_and_notify_upcoming_classes(ctx.storage, supabase=ctx.supabase, deliver=ctx.deliver)),
        # Custom reminders (Supabase -> every channel of each owner)
        ("recordatorios personalizados",
         lambda: process_due_reminders(ctx.supabase, deliver=reminder_deliverer(ctx.deliver))),
        # Web Push test requests: the web only sets test_requested_at, the worker sends the push
        ("pruebas de Web Push", lambda: process_push_tests(ctx.supabase, ctx.sender, history=ctx.history)),
    )
    try:
        for label, step in steps:
            if ctx.stopping:
                break
            try:
                step()
            except Exception as err:  # noqa: BLE001
                ctx.delivery_error = True
                print(f"[{_stamp()}] [!] Error en {label}: {err}")
    finally:
        # The pushes above link to their history rows: write them now, not after the task sync.
        _flush_history(ctx)


def _after_user_hook(ctx: WorkerContext) -> Callable[[], None]:
    return partial(_flush_history, ctx)


def fetch_fresh_logins(supabase, seen_logins: Dict[str, str]) -> List[Dict]:
    """Full rows of the users that logged in since the worker last synced them.

    Uses the token-free ``fetch_login_markers`` and ``fetch_users_by_ids`` of the data layer when they
    exist (only the changed rows, tokens included, are read), else the full active-users read.
    """
    markers = getattr(supabase, "fetch_login_markers", None)
    by_ids = getattr(supabase, "fetch_users_by_ids", None)
    if callable(markers) and callable(by_ids):
        changed = users_needing_immediate_sync(markers() or [], seen_logins)
        if not changed:
            return []
        rows = by_ids([_user_id(m) for m in changed]) or []
        return users_needing_immediate_sync([u for u in rows if str(u.get("token") or "").strip()], seen_logins)
    return users_needing_immediate_sync(supabase.fetch_active_users(), seen_logins)


def _sync_options(ctx: WorkerContext) -> Dict[str, Any]:
    return dict(
        deliver=ctx.deliver, after_user=_after_user_hook(ctx), between_users=ctx.delivery_if_due,
        budget_seconds=ROUND_BUDGET_SECONDS, pause_seconds=USER_PAUSE_SECONDS, stop_event=ctx.stop_event,
    )


# ---- health: heartbeat, dead-man switch, startup checks ------------------------------------------


def worker_version(env: Optional[Dict[str, str]] = None) -> str:
    """``WORKER_VERSION`` env, else the short git revision of this checkout, else a constant."""
    env = os.environ if env is None else env
    explicit = str(env.get("WORKER_VERSION") or "").strip()
    if explicit:
        return explicit[:40]
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=SCRIPT_DIR, capture_output=True,
                             text=True, timeout=2)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()[:40]
    except Exception:  # noqa: BLE001 - git missing or slow: the constant is enough
        pass
    return WORKER_VERSION


def _push_counts(ctx: WorkerContext) -> Optional[Dict[str, Any]]:
    """The sender's per-tick counters (``stats_snapshot``), when the sender provides them."""
    snapshot = getattr(ctx.sender, "stats_snapshot", None)
    if not callable(snapshot):
        return None
    try:
        stats = snapshot(reset=True)
    except Exception as err:  # noqa: BLE001
        _log_on_change("push-stats", f"[{_stamp()}] [!] No se pudieron leer las estadísticas de Web Push: {err}")
        return None
    if not isinstance(stats, dict):
        return None
    if stats.get("last_ok_at"):
        ctx.last_push_ok_at = str(stats["last_ok_at"])
    counts = {k: v for k, v in stats.items() if k != "last_ok_at"}
    if counts.get("last_error") is not None:
        counts["last_error"] = _scrub(counts["last_error"])
    return counts


def build_heartbeat(ctx: WorkerContext, tick_seconds: float, sync_seconds: float) -> Dict[str, Any]:
    """The ``worker_status`` document (contract C5) plus ``degraded`` / ``degraded_reasons``.

    ``users_ok`` / ``users_err`` / ``last_round_mode`` describe the latest full Moodle round,
    ``push_counts`` the pushes since the previous heartbeat, and ``delivery_lag_seconds`` how much
    longer than ``DELIVERY_INTERVAL_SECONDS`` the longest gap between two delivery passes was since
    the previous heartbeat (0 = on time). Holds no secrets: statuses are scrubbed of e-mails/URLs.
    """
    lag = max(0.0, ctx.max_delivery_gap - DELIVERY_INTERVAL_SECONDS)
    ctx.max_delivery_gap = 0.0
    push_counts = _push_counts(ctx)  # first: it refreshes last_push_ok_at
    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "version": ctx.version,
        "webpush_enabled": bool(getattr(ctx.sender, "enabled", False)),
        "push_status": _scrub(getattr(ctx.sender, "status", "")),
        "last_push_ok_at": ctx.last_push_ok_at,
        "push_counts": push_counts,
        "users_ok": ctx.users_ok,
        "users_err": ctx.users_err,
        "last_round_mode": ctx.last_round_mode,
        "tick_seconds": round(tick_seconds, 1),
        "sync_seconds": round(sync_seconds, 1),
        "delivery_lag_seconds": round(lag, 1),
        "degraded": bool(ctx.degraded_reasons),
        "degraded_reasons": list(ctx.degraded_reasons),
    }


def write_heartbeat(ctx: WorkerContext, payload: Dict[str, Any]) -> bool:
    """Upsert ``worker_status``. Never raises; a failure is logged once until it changes."""
    upsert = getattr(ctx.supabase, "upsert_setting", None)
    if not callable(upsert) or not getattr(ctx.supabase, "is_configured", False):
        return False
    try:
        ok = upsert(WORKER_STATUS_KEY, json.dumps(payload, ensure_ascii=False), async_call=False)
    except Exception as err:  # noqa: BLE001
        ok = False
        _log_on_change("heartbeat", f"[{_stamp()}] [!] No se pudo escribir worker_status: {type(err).__name__}")
    else:
        _log_on_change("heartbeat", None if ok is not False else
                       f"[{_stamp()}] [!] No se pudo escribir worker_status (ver log de Supabase).")
    return ok is not False


def ping_healthcheck(ctx: WorkerContext, http_get: Optional[Callable[..., Any]] = None,
                     env: Optional[Dict[str, str]] = None, heartbeat_ok: bool = True) -> None:
    """Dead-man switch: GET ``HEALTHCHECK_URL`` (``/fail`` appended when the worker is unhealthy).

    Unhealthy = Web Push disabled, a degraded startup, a crashed tick, a failed delivery step, a
    latest users read that failed, or a heartbeat that could not be written (``heartbeat_ok``: an
    unreachable or rejecting Supabase between rounds). Never raises; the URL is never logged (it is
    a secret of the monitoring service).
    """
    env = os.environ if env is None else env
    url = str(env.get("HEALTHCHECK_URL") or "").strip()
    if not url:
        return
    healthy = (bool(getattr(ctx.sender, "enabled", False)) and not ctx.degraded_reasons
               and not ctx.round_error and not ctx.tick_crashed and not ctx.delivery_error
               and heartbeat_ok)
    target = url if healthy else url.rstrip("/") + "/fail"
    try:
        if http_get is None:
            import requests

            http_get = requests.get
        http_get(target, timeout=HEALTHCHECK_TIMEOUT_SECONDS)
    except Exception as err:  # noqa: BLE001
        _log_on_change("healthcheck", f"[{_stamp()}] [!] Healthcheck sin respuesta: {type(err).__name__}")
    else:
        _log_on_change("healthcheck", None)


def report_tick(ctx: WorkerContext, tick_seconds: float, sync_seconds: float) -> None:
    """Heartbeat plus dead-man switch (end of a tick, or between users of a long round). Never raises."""
    ctx.last_report_at = ctx.clock()
    heartbeat_ok = False
    try:
        heartbeat_ok = write_heartbeat(ctx, build_heartbeat(ctx, tick_seconds, sync_seconds))
    except Exception as err:  # noqa: BLE001
        print(f"[{_stamp()}] [!] Error al preparar worker_status: {err}")
    ping_healthcheck(ctx, heartbeat_ok=heartbeat_ok)


def report_if_due(ctx: WorkerContext) -> None:
    """Mid-round heartbeat: ``report_tick`` when ``HEARTBEAT_INTERVAL_SECONDS`` passed since the last one."""
    now = ctx.clock()
    if ctx.last_report_at is not None and now - ctx.last_report_at < HEARTBEAT_INTERVAL_SECONDS:
        return
    tick_seconds = now - ctx.tick_started if ctx.tick_started is not None else 0.0
    sync_seconds = now - ctx.sync_started if ctx.sync_started is not None else 0.0
    report_tick(ctx, tick_seconds, sync_seconds)


def prune_storage_if_due(ctx: WorkerContext) -> None:
    """Once a (local) day: drop stale class-reminder keys, when the storage layer supports it."""
    prune = getattr(ctx.storage, "prune_stale_class_keys", None)
    today = datetime.now().strftime("%Y-%m-%d")
    if not callable(prune) or ctx.last_storage_prune_day == today:
        return
    ctx.last_storage_prune_day = today
    try:
        removed = prune()
        if removed:
            print(f"[{_stamp()}] 🧹 Claves de clases antiguas eliminadas: {removed}")
    except Exception as err:  # noqa: BLE001
        print(f"[{_stamp()}] [!] Error al depurar claves de clases: {err}")


def startup_problems(supabase, sender, env: Optional[Dict[str, str]] = None) -> List[str]:
    """Reasons (keys of ``DEGRADED_MESSAGES``) the worker would run degraded."""
    env = os.environ if env is None else env
    problems = []
    if not getattr(supabase, "is_configured", False):
        problems.append("supabase_not_configured")
    if not getattr(sender, "enabled", False):
        problems.append("webpush_disabled")
    elif resolve_subject(env)[1]:
        problems.append("vapid_subject_placeholder")
    return problems


def check_startup(supabase, sender, env: Optional[Dict[str, str]] = None) -> List[str]:
    """Log every startup problem loudly. With ``WORKER_STRICT=1`` any problem exits with code 1."""
    env = os.environ if env is None else env
    problems = startup_problems(supabase, sender, env)
    if not problems:
        return problems
    strict = str(env.get("WORKER_STRICT") or "").strip() == "1"
    print("!" * 60)
    print("  ⚠️ ⚠️ WORKER EN MODO DEGRADADO" + (" (WORKER_STRICT=1: se detiene)" if strict else ""))
    for reason in problems:
        print(f"  - [{reason}] {DEGRADED_MESSAGES[reason]}")
    if not strict:
        print("  El estado se publica en worker_status (panel /admin). WORKER_STRICT=1 lo vuelve fatal.")
    print("!" * 60)
    if strict:
        sys.exit(1)
    return problems


class InstanceLock:
    """Exclusive, non-blocking lock on a file, held for the process lifetime (one worker per database)."""

    def __init__(self, path: str):
        self.path = path
        self._handle = None

    def acquire(self) -> bool:
        handle = open(self.path, "a+")
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self._handle = handle
        return True

    def release(self) -> None:
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            handle.close()


def acquire_instance_lock(storage) -> InstanceLock:
    """Lock ``<database>.lock`` next to the SQLite file, or exit with code 1 when another worker holds it."""
    lock = InstanceLock(f"{storage.db_path}.lock")
    if not lock.acquire():
        print(f"[{_stamp()}] [!] Ya hay otro worker en ejecución con {os.path.basename(storage.db_path)} "
              f"(bloqueo {lock.path}); este proceso se cierra.")
        sys.exit(1)
    return lock


def hydrate_storage(storage, supabase) -> bool:
    """Restore dedupe state from Supabase into a fresh local database, when the storage layer can.

    Returns False only when the restore failed and must be retried (``{"error": ...}`` or a raise);
    a restore that ran, was not needed or is not supported returns True.
    """
    hydrate = getattr(storage, "hydrate_from_remote", None)
    if not callable(hydrate):
        return True
    try:
        result = hydrate(supabase)
    except Exception as err:  # noqa: BLE001
        print(f"  [!] No se pudo restaurar el estado local desde Supabase: {type(err).__name__}")
        return False
    if isinstance(result, dict) and result.get("error"):
        print("  [!] No se pudo restaurar el estado local desde Supabase; se reintenta en el próximo ciclo "
              "antes de revisar Moodle.")
        return False
    print(f"  ♻️ Estado local restaurado desde Supabase: {result}")
    return True


def retry_hydration(ctx: WorkerContext) -> bool:
    """Retry a failed startup restore. True when the Moodle round may run.

    A fresh SQLite file must get its dedupe state back before any round records milestones, or every
    alert already sent would go out again; after ``HYDRATION_MAX_WAIT_SECONDS`` the rounds run anyway
    (a restore that can never succeed must not stop the task sync for good).
    """
    ctx.hydrated = hydrate_storage(ctx.storage, ctx.supabase)
    if ctx.hydrated:
        return True
    if ctx.hydration_deadline is None:
        ctx.hydration_deadline = ctx.clock() + HYDRATION_MAX_WAIT_SECONDS
    if ctx.clock() < ctx.hydration_deadline:
        return False
    print(f"[{_stamp()}] [!] ⚠️ El estado local no se pudo restaurar desde Supabase en "
          f"{HYDRATION_MAX_WAIT_SECONDS // 60} min; se revisa Moodle igualmente (pueden repetirse avisos).")
    ctx.hydrated = True
    return True


def publish_vapid_public_key(supabase, sender) -> None:
    """Publish the sender's public key so the web can detect subscriptions bound to another key."""
    key = getattr(sender, "public_key_b64", None)
    upsert = getattr(supabase, "upsert_setting", None)
    if not getattr(sender, "enabled", False) or not isinstance(key, str) or not key or not callable(upsert):
        return
    try:
        if upsert(VAPID_PUBLIC_KEY_SETTING, key, async_call=False) is False:
            print("  [!] No se pudo publicar vapid_public_key en moodle_settings.")
    except Exception as err:  # noqa: BLE001
        print(f"  [!] No se pudo publicar vapid_public_key: {type(err).__name__}")


def run_tick(ctx: WorkerContext) -> None:
    """One tick: the delivery pass, then a Moodle round (or a cheap new-login check). Never raises
    an ``Exception``: a crash is logged with its traceback, the history is still flushed and the
    heartbeat still written."""
    ctx.tick_crashed = False
    tick_started = ctx.tick_started = ctx.clock()
    ctx.sync_started = None
    sync_seconds = 0.0
    try:
        run_delivery_pass(ctx)
        if ctx.stopping:
            return
        if not ctx.hydrated and not retry_hydration(ctx):
            return
        now_ts = time.time()
        sync_started = ctx.sync_started = ctx.clock()
        if now_ts - ctx.last_tasks_check >= ctx.tasks_check_seconds:
            print(f"\n[{_stamp()}] 📋 Verificando Moodle y actualizando tareas...")
            ctx.last_tasks_check = now_ts
            stats: Dict[str, Any] = {}
            try:
                ctx.last_round_mode = run_task_tick(
                    ctx.storage, ctx.supabase, seen_logins=ctx.seen_logins, planner=ctx.planner, stats=stats,
                    **_sync_options(ctx),
                )
            finally:
                sync_seconds = ctx.clock() - sync_started
            ctx.users_ok, ctx.users_err = stats.get("users_ok", 0), stats.get("users_err", 0)
            ctx.round_error = bool(stats.get("error"))
        else:
            # New logins/registrations are synced right away instead of waiting for the next round.
            try:
                fresh = fetch_fresh_logins(ctx.supabase, ctx.seen_logins)
            except Exception as err:
                fresh = []
                ctx.round_error = True
                print(f"[{_stamp()}] [!] No se pudo revisar inicios de sesión nuevos: {err}")
            else:
                ctx.round_error = False  # the users table is readable again
            if fresh:
                print(f"\n[{_stamp()}] 🆕 Sincronizando {len(fresh)} usuario(s) con inicio de sesión reciente...")
                outcomes = sync_all_users(ctx.storage, ctx.supabase, fresh, **_sync_options(ctx))
                remember_logins(_reached(fresh, outcomes), ctx.seen_logins)
                sync_seconds = ctx.clock() - sync_started
    except Exception:  # noqa: BLE001 - one bad tick must never stop the worker
        ctx.tick_crashed = True
        print(f"[{_stamp()}] [!] Error inesperado en el ciclo del worker; se continúa en el próximo ciclo.\n"
              f"{traceback.format_exc()}")
    finally:
        # Never raise: write whatever is still buffered (also after a crash), then the daily prune.
        _flush_history(ctx)
        try:
            ctx.history.prune_if_due(ctx.storage)
        except Exception as err:  # noqa: BLE001
            print(f"[{_stamp()}] [!] Error al depurar el historial de avisos: {err}")
        prune_storage_if_due(ctx)
        report_tick(ctx, ctx.clock() - tick_started, sync_seconds)


def run_loop(ctx: WorkerContext, tick_seconds: float = TICK_SECONDS,
             wait: Optional[Callable[[float], Any]] = None) -> None:
    """Tick until a stop is requested; each wait is the remainder of ``tick_seconds``."""
    wait = wait or ctx.stop_event.wait
    while not ctx.stopping:
        started = ctx.clock()
        run_tick(ctx)
        if ctx.stopping:
            break
        wait(max(0.0, tick_seconds - (ctx.clock() - started)))


def install_stop_handlers(stop_event: threading.Event) -> Callable[[], None]:
    """SIGINT/SIGTERM set ``stop_event`` (a second signal aborts at once). Returns a restore callable."""
    previous: Dict[int, Any] = {}

    def handler(signum, _frame):
        if stop_event.is_set():
            raise KeyboardInterrupt
        print(f"[{_stamp()}] 🛑 Señal {signum} recibida: el worker se detiene al terminar el paso en curso.")
        stop_event.set()

    for name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            previous[sig] = signal.signal(sig, handler)
        except (ValueError, OSError):  # not the main thread, or unsupported here
            pass

    def restore() -> None:
        for sig, old in previous.items():
            try:
                signal.signal(sig, old)
            except (ValueError, OSError, TypeError):
                pass

    return restore


def run_worker(stop_event: Optional[threading.Event] = None, tick_seconds: float = TICK_SECONDS) -> None:
    """Ejecutor en segundo plano: tareas y recordatorios por usuario + recordatorios de clases por usuario."""
    storage = Storage()
    lock = acquire_instance_lock(storage)  # exits when another worker already runs on this database
    try:
        _run_worker(storage, stop_event, tick_seconds)
    finally:
        lock.release()


def _run_worker(storage, stop_event: Optional[threading.Event], tick_seconds: float) -> None:
    try:
        tasks_check_mins = int(storage.get_setting("check_interval_mins", "30"))
    except ValueError:
        tasks_check_mins = 30

    supabase = SupabaseClient.for_worker()
    # Web Push is the primary channel; without pywebpush or a VAPID key it is disabled and only ntfy is used.
    sender = WebPushSender.from_env(supabase)
    # Every delivery attempt is buffered here and written after each delivery phase (see notification_log.py).
    history = NotificationLog(supabase)
    deliver = partial(deliver_to_user, supabase=supabase, sender=sender, history=history)
    ctx = WorkerContext(storage, supabase, sender, history, deliver, stop_event=stop_event,
                        tasks_check_seconds=tasks_check_mins * 60)
    ctx.version = worker_version()

    print("=" * 60)
    print("  🚀 MOODLE TRACKER - HEADLESS WORKER (MULTIUSUARIO)")
    db_host = urlparse(storage.supabase.url).netloc if storage.supabase.is_configured else ""
    print(f"  🗄️ Base de datos: {db_host or 'Desactivada (solo SQLite local)'}")
    print(f"  📲 {sender.status}")
    if sender.warning:
        print(f"  ⚠️ {sender.warning}")
    print(f"  🔔 ntfy (canal opcional por usuario): {ntfy_base_url()}")
    print(f"  📋 Revisión de tareas: cada {tasks_check_mins} minutos (máx. {ROUND_BUDGET_SECONDS // 60} min por ronda)")
    print("  🎓 Alertas de clases: según el horario importado de cada usuario (30 min, 1 h o 3 h antes)")
    print(f"  🏷️ Versión: {ctx.version} (estado en moodle_settings.{WORKER_STATUS_KEY} cada ciclo)")
    print("=" * 60)
    ctx.degraded_reasons = check_startup(supabase, sender)  # exits with WORKER_STRICT=1
    report_tick(ctx, 0.0, 0.0)  # the degraded state reaches /admin before the first (long) round
    ctx.hydrated = hydrate_storage(storage, supabase)
    if not ctx.hydrated:
        ctx.hydration_deadline = ctx.clock() + HYDRATION_MAX_WAIT_SECONDS
    publish_vapid_public_key(supabase, sender)

    restore = install_stop_handlers(ctx.stop_event)
    try:
        run_loop(ctx, tick_seconds)
    finally:
        restore()
        print(f"[{_stamp()}] 👋 Worker detenido.")


if __name__ == "__main__":
    run_worker()
