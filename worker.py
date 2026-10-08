"""Headless multi-user worker: Moodle task sync plus every time-critical delivery.

One tick per ``TICK_SECONDS``. Each tick starts with the delivery pass (class reminders, custom
reminders, Web Push tests, then the notification history), so those keep their cadence however slow
Moodle is: during a long Moodle round the pass also runs between users, at most once per
``DELIVERY_INTERVAL_SECONDS``. A round has a wall-clock budget; users it did not reach go first next
round. SIGINT/SIGTERM stop the loop at a step boundary, and an unexpected exception in a tick is
logged and survived.
"""
import inspect
import os
import signal
import sys
import threading
import time
import traceback
from datetime import datetime
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
from webpush_sender import TTL_REMINDER, WebPushSender

TICK_SECONDS = 60
# The delivery pass runs at most this often between the users of a long Moodle round.
DELIVERY_INTERVAL_SECONDS = 60
# Wall-clock budget of one Moodle round; users not reached go first in the next round.
ROUND_BUDGET_SECONDS = 600
# Pause between two users of a round (politeness towards Moodle).
USER_PAUSE_SECONDS = 0.5


def _stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _user_id(user: Dict) -> str:
    return str(user.get("id") or "")


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
        self.round_error = False  # the last tick crashed or could not read the users

    @property
    def stopping(self) -> bool:
        return self.stop_event.is_set()

    def delivery_if_due(self) -> None:
        """The delivery pass, when ``DELIVERY_INTERVAL_SECONDS`` passed since the last one."""
        if self.last_delivery_at is None or self.clock() - self.last_delivery_at >= DELIVERY_INTERVAL_SECONDS:
            run_delivery_pass(self)


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


def run_tick(ctx: WorkerContext) -> None:
    """One tick: the delivery pass, then a Moodle round (or a cheap new-login check). Never raises
    an ``Exception``: a crash is logged with its traceback and the history is still flushed."""
    ctx.round_error = False
    try:
        run_delivery_pass(ctx)
        if ctx.stopping:
            return
        now_ts = time.time()
        if now_ts - ctx.last_tasks_check >= ctx.tasks_check_seconds:
            print(f"\n[{_stamp()}] 📋 Verificando Moodle y actualizando tareas...")
            ctx.last_tasks_check = now_ts
            stats: Dict[str, Any] = {}
            ctx.last_round_mode = run_task_tick(
                ctx.storage, ctx.supabase, seen_logins=ctx.seen_logins, planner=ctx.planner, stats=stats,
                **_sync_options(ctx),
            )
            ctx.users_ok, ctx.users_err = stats.get("users_ok", 0), stats.get("users_err", 0)
            ctx.round_error = bool(stats.get("error"))
        else:
            # New logins/registrations are synced right away instead of waiting for the next round.
            try:
                fresh = fetch_fresh_logins(ctx.supabase, ctx.seen_logins)
            except Exception as err:
                fresh = []
                print(f"[{_stamp()}] [!] No se pudo revisar inicios de sesión nuevos: {err}")
            if fresh:
                print(f"\n[{_stamp()}] 🆕 Sincronizando {len(fresh)} usuario(s) con inicio de sesión reciente...")
                outcomes = sync_all_users(ctx.storage, ctx.supabase, fresh, **_sync_options(ctx))
                remember_logins(_reached(fresh, outcomes), ctx.seen_logins)
    except Exception:  # noqa: BLE001 - one bad tick must never stop the worker
        ctx.round_error = True
        print(f"[{_stamp()}] [!] Error inesperado en el ciclo del worker; se continúa en el próximo ciclo.\n"
              f"{traceback.format_exc()}")
    finally:
        # Never raise: write whatever is still buffered (also after a crash), then the daily prune.
        _flush_history(ctx)
        try:
            ctx.history.prune_if_due(ctx.storage)
        except Exception as err:  # noqa: BLE001
            print(f"[{_stamp()}] [!] Error al depurar el historial de avisos: {err}")


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
    print("=" * 60)

    restore = install_stop_handlers(ctx.stop_event)
    try:
        run_loop(ctx, tick_seconds)
    finally:
        restore()
        print(f"[{_stamp()}] 👋 Worker detenido.")


if __name__ == "__main__":
    run_worker()
