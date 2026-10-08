"""Static checks of supabase_schema.sql (no database needed).

The file is applied by hand to a self-hosted Supabase that is shared with another production
project, so it must stay re-runnable and must only touch public.moodle_* objects. These tests read
the SQL as text and pin those rules plus the objects other packages rely on (contract C1).
"""
import re
from pathlib import Path

import pytest

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "supabase_schema.sql"
RAW = SCHEMA_PATH.read_text(encoding="utf-8")
SECTION_11_HEADER = "-- 11. Hardening"
SECTION_12_HEADER = "-- 12. Grade statistics"
GRADE_COLUMNS = ["user_id", "course_id", "item_id", "course_name", "item_name", "item_type", "item_module", "cmid",
                 "item_instance", "category_id", "sort_order", "report_depth", "grade_raw", "grade_min", "grade_max",
                 "grade_formatted", "percentage_formatted", "weight_raw", "graded_at", "notified_grade", "fetched_at"]


def _strip_comments(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


SQL = _strip_comments(RAW)
SECTION_11 = _strip_comments(RAW[RAW.index(SECTION_11_HEADER):])
DO_BLOCKS = re.findall(r"\bDO \$\$(.*?)\$\$;", SQL, flags=re.S)

NEW_FUNCTIONS = {
    "moodle_tasks_keep_details_stamp": "()",
    "moodle_login_gate": "(text)",
    "moodle_login_result": "(text, boolean)",
    "moodle_replace_class_schedule": "(uuid, jsonb)",
    "moodle_login_reserve": "(text, integer)",
    "moodle_login_settle": "(text, text, integer)",
    "moodle_login_begin": "(text, text)",
    "moodle_login_finish": "(text, text, text)",
}
RPC_FUNCTIONS = ("moodle_login_gate", "moodle_login_result", "moodle_replace_class_schedule",
                 "moodle_login_reserve", "moodle_login_settle", "moodle_login_begin", "moodle_login_finish")


def _ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _function_body(name: str) -> str:
    match = re.search(
        rf"CREATE OR REPLACE FUNCTION public\.{name}\(.*?\)(.*?)AS \$\$(.*?)\$\$;", SQL, flags=re.S
    )
    assert match, f"function {name} is not defined"
    return match.group(1) + match.group(2)


def _table_columns(table: str) -> list:
    match = re.search(rf"CREATE TABLE IF NOT EXISTS public\.{table} \((.*?)\n\);", SQL, flags=re.S)
    assert match, f"table {table} is not defined"
    columns = []
    for line in match.group(1).splitlines():
        token = line.strip().split(" ", 1)[0]
        if token and token.isidentifier() and token.upper() not in ("CHECK", "UNIQUE", "PRIMARY"):
            columns.append(token)
    return columns


@pytest.mark.parametrize(
    "fragment",
    [
        "ADD COLUMN IF NOT EXISTS ntfy_confirmed_at timestamptz",
        "ADD COLUMN IF NOT EXISTS last_synced_at timestamptz",
        "ADD COLUMN IF NOT EXISTS last_failure_reason text",
        "ADD COLUMN IF NOT EXISTS push_state text",
        "ADD COLUMN IF NOT EXISTS missing_since timestamptz",
        "CREATE TRIGGER moodle_tasks_a_keep_details_stamp",
        "CREATE TRIGGER moodle_tasks_z_skip_noop",
        "CREATE TABLE IF NOT EXISTS public.moodle_login_failures",
        "CREATE INDEX IF NOT EXISTS idx_moodle_custom_reminders_task",
        "DROP INDEX IF EXISTS public.idx_moodle_tasks_status",
        "moodle_notification_log_push_state_check",
        "moodle_tasks_status_check",
        "moodle_tasks_is_dismissed_check",
        "moodle_task_milestones_milestone_check",
        "moodle_push_subscriptions_failure_count_check",
        "moodle_push_subscriptions_last_failure_reason_check",
        "moodle_notification_log_push_counts_check",
    ],
)
def test_new_objects_are_present(fragment):
    assert fragment in SECTION_11


@pytest.mark.parametrize("name", sorted(NEW_FUNCTIONS))
def test_new_functions_are_present(name):
    assert f"CREATE OR REPLACE FUNCTION public.{name}(" in SECTION_11


def test_every_table_index_function_and_alter_names_a_moodle_object():
    statements = {
        "CREATE TABLE": r"CREATE TABLE(?: IF NOT EXISTS)? (\S+)",
        "CREATE INDEX": r"CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? (\S+)\s+ON (\S+)",
        "CREATE FUNCTION": r"CREATE (?:OR REPLACE )?FUNCTION (\S+?)\(",
        "ALTER TABLE": r"ALTER TABLE (\S+)",
        "DROP INDEX": r"DROP INDEX(?: IF EXISTS)? (\S+)",
        "CREATE TRIGGER": r"CREATE TRIGGER (\S+)\s+BEFORE \w+(?: OF [\w, ]+)? ON (\S+)",
    }
    seen = 0
    for kind, pattern in statements.items():
        for match in re.finditer(pattern, SQL):
            for name in match.groups():
                seen += 1
                bare = name.split(".", 1)[-1]
                assert bare.startswith(("moodle_", "idx_moodle_")), f"{kind} touches {name}"
                if kind in ("CREATE TABLE", "ALTER TABLE", "CREATE FUNCTION", "DROP INDEX"):
                    assert name.startswith("public."), f"{kind} {name} must be schema-qualified"
    assert seen > 40


def test_every_add_column_is_guarded():
    adds = re.findall(r"ADD COLUMN(?! IF NOT EXISTS)", SQL)
    assert adds == []
    assert len(re.findall(r"ADD COLUMN IF NOT EXISTS", SECTION_11)) == 7


def test_every_add_constraint_sits_in_a_do_block_that_checks_pg_constraint():
    names = re.findall(r"ADD CONSTRAINT (\w+)", SQL)
    assert len(names) >= 10
    for name in names:
        blocks = [b for b in DO_BLOCKS if f"ADD CONSTRAINT {name}" in b]
        assert len(blocks) == 1, f"{name} is not inside exactly one DO block"
        block = blocks[0]
        assert "pg_constraint" in block and f"conname = '{name}'" in block
        assert block.index("IF NOT EXISTS") < block.index(f"ADD CONSTRAINT {name}")


def test_new_check_constraints_are_added_not_valid_then_validated():
    for name in re.findall(r"ADD CONSTRAINT (\w+_check)", SECTION_11):
        block = next(b for b in DO_BLOCKS if f"ADD CONSTRAINT {name}" in b)
        assert "NOT VALID" in block
        assert f"VALIDATE CONSTRAINT {name}" in block
        # A pre-existing bad row must not abort the whole file.
        assert "EXCEPTION WHEN check_violation" in block


def test_push_counts_check_accepts_unreadable_devices():
    block = next(b for b in DO_BLOCKS if "moodle_notification_log_push_counts_check" in b)
    assert "push_total >= -1" in block and "push_ok >= 0" in block
    assert "push_ok <= greatest(push_total, 0)" in block


def test_push_state_check_allows_null_and_the_contract_values():
    block = _ws(next(b for b in DO_BLOCKS if "moodle_notification_log_push_state_check" in b))
    assert (
        "push_state IS NULL OR push_state IN "
        "('ok', 'partial', 'failed', 'no_devices', 'read_error', 'disabled')"
    ) in block
    # The status CHECK of the history is untouched.
    assert "status text NOT NULL CHECK (status IN ('sent', 'failed'))" in _ws(SQL)


@pytest.mark.parametrize("name", sorted(NEW_FUNCTIONS))
def test_new_functions_are_security_invoker_with_a_fixed_search_path(name):
    head = _function_body(name)
    assert "SECURITY INVOKER" in head and "SECURITY DEFINER" not in head
    assert "SET search_path = public" in head


@pytest.mark.parametrize("name", sorted(NEW_FUNCTIONS))
def test_new_functions_revoke_execute_from_public_and_anon(name):
    signature = NEW_FUNCTIONS[name]
    assert f"REVOKE EXECUTE ON FUNCTION public.{name}{signature} FROM PUBLIC, anon, authenticated;" in SQL


@pytest.mark.parametrize("name", RPC_FUNCTIONS)
def test_rpc_functions_are_granted_to_moodle_app(name):
    assert f"GRANT EXECUTE ON FUNCTION public.{name}{NEW_FUNCTIONS[name]} TO moodle_app;" in SQL


def test_login_failures_table_follows_the_moodle_app_model():
    assert "ALTER TABLE public.moodle_login_failures ENABLE ROW LEVEL SECURITY;" in SQL
    assert "REVOKE ALL ON public.moodle_login_failures FROM PUBLIC, anon, authenticated;" in SQL
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_login_failures TO moodle_app;" in SQL
    assert "DROP POLICY IF EXISTS moodle_app_all ON public.moodle_login_failures;" in SQL
    assert "CREATE POLICY moodle_app_all ON public.moodle_login_failures" in SQL
    assert _table_columns("moodle_login_failures") == ["key_hash", "failures", "window_start", "blocked_until"]


def test_login_throttle_window_and_block():
    result = _ws(_function_body("moodle_login_result"))
    assert "DELETE FROM public.moodle_login_failures WHERE key_hash = p_key_hash" in result
    assert "ON CONFLICT (key_hash) DO UPDATE" in result
    assert "interval '15 minutes'" in result and "f.failures + 1 >= 5" in result
    assert "window_start < now() - interval '1 day'" in result
    gate = _ws(_function_body("moodle_login_gate"))
    assert "greatest(0, ceil(extract(epoch FROM (f.blocked_until - now()))))::integer" in gate
    assert "COALESCE(" in gate


def test_login_attempts_are_reserved_atomically_before_moodle_is_called():
    reserve = _ws(_function_body("moodle_login_reserve"))
    assert "VOLATILE" in reserve and "FOR UPDATE" in reserve
    assert "f.failures + f.in_flight >= p_limit" in reserve and "f.in_flight := f.in_flight + 1" in reserve
    assert "interval '2 minutes'" in reserve  # a reservation of a request that died is released
    begin = _ws(_function_body("moodle_login_begin"))
    assert "public.moodle_login_reserve(p_key_hash, 5)" in begin
    assert "public.moodle_login_reserve(p_user_key_hash, 20)" in begin
    assert "public.moodle_login_settle(p_key_hash, 'released', 5)" in begin  # no leaked reservation
    settle = _ws(_function_body("moodle_login_settle"))
    assert "greatest(0, f.in_flight - 1)" in settle and "f.failures + 1 >= p_limit" in settle
    assert "ALTER TABLE public.moodle_login_failures ADD COLUMN IF NOT EXISTS in_flight integer" in SECTION_11


def test_the_schedule_replace_is_serialized_per_user():
    body = _ws(_function_body("moodle_replace_class_schedule"))
    lock = body.index("pg_advisory_xact_lock(")
    assert lock < body.index("DELETE FROM public.moodle_class_schedule")


def test_triggers_are_recreated_and_fire_stamp_first():
    for trigger in ("moodle_tasks_a_keep_details_stamp", "moodle_tasks_z_skip_noop"):
        drop = SQL.index(f"DROP TRIGGER IF EXISTS {trigger} ON public.moodle_tasks;")
        assert drop < SQL.index(f"CREATE TRIGGER {trigger}")
    # Postgres fires same-event row triggers in name order.
    assert "moodle_tasks_a_keep_details_stamp" < "moodle_tasks_z_skip_noop"
    noop = _ws(SQL[SQL.index("CREATE TRIGGER moodle_tasks_z_skip_noop"):])
    # Only the worker upsert (whose SET list always holds title) is suppressed: the web's mute PATCH
    # sets is_dismissed alone and needs its row back even when the value did not change.
    assert noop.startswith(
        "CREATE TRIGGER moodle_tasks_z_skip_noop BEFORE UPDATE OF title ON public.moodle_tasks "
        "FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();"
    )
    stamp = _ws(SQL[SQL.index("CREATE TRIGGER moodle_tasks_a_keep_details_stamp"):])
    assert stamp.startswith(
        "CREATE TRIGGER moodle_tasks_a_keep_details_stamp BEFORE UPDATE ON public.moodle_tasks FOR EACH ROW"
    )


def test_keep_details_stamp_compares_the_real_detail_columns():
    columns = _table_columns("moodle_tasks") + re.findall(
        r"ALTER TABLE public\.moodle_tasks ADD COLUMN IF NOT EXISTS (\w+)", SQL
    )
    assert {"description", "teachers", "details_updated_at"} <= set(columns)
    assert "updated_at" not in columns  # nothing else is stamped on every upsert
    body = _ws(_function_body("moodle_tasks_keep_details_stamp"))
    assert "NEW.description IS NOT DISTINCT FROM OLD.description" in body
    assert "NEW.teachers IS NOT DISTINCT FROM OLD.teachers" in body
    assert "NEW.details_updated_at := OLD.details_updated_at" in body
    assert "RETURN NEW" in body


def test_replace_class_schedule_lists_the_exact_table_columns():
    table = [c for c in _table_columns("moodle_class_schedule") if c not in ("id", "created_at")]
    body = _function_body("moodle_replace_class_schedule")
    insert = re.search(r"INSERT INTO public\.moodle_class_schedule \((.*?)\)", body, flags=re.S)
    assert [c.strip() for c in insert.group(1).split(",")] == table
    record = re.search(r"jsonb_to_recordset\(p_rows\) AS r\((.*?)\);", body, flags=re.S)
    declared = [line.strip().split()[0] for line in record.group(1).split(",")]
    assert declared == [c for c in table if c != "user_id"]
    assert "DELETE FROM public.moodle_class_schedule WHERE user_id = p_user_id" in body
    assert "jsonb_typeof(p_rows) <> 'array'" in body


def test_status_index_is_dropped_and_never_recreated():
    assert "idx_moodle_tasks_status ON" not in SQL
    assert "CREATE INDEX IF NOT EXISTS idx_moodle_tasks_due" in SQL
    assert "WHERE task_id IS NOT NULL" in SECTION_11


def test_ntfy_enabled_keeps_existing_users_on_and_defaults_new_users_to_off():
    # ADD COLUMN fills the rows that exist at that moment with the default: existing users (ntfy was
    # their only channel) keep it on; 11.1 then makes new users start with it off.
    assert "ADD COLUMN IF NOT EXISTS ntfy_enabled boolean NOT NULL DEFAULT true" in SQL
    assert "ALTER TABLE public.moodle_users ALTER COLUMN ntfy_enabled SET DEFAULT false;" in SECTION_11
    assert SQL.index("ntfy_enabled boolean NOT NULL DEFAULT true") < SQL.index("ALTER COLUMN ntfy_enabled SET DEFAULT false")


def test_only_admins_using_ntfy_are_backfilled_and_only_once():
    statements = re.sub(r"\$\$.*?\$\$", "", SECTION_11, flags=re.S)  # function bodies are not data changes
    updates = [_ws(u) for u in re.findall(r"\bUPDATE public\.\w+.*?;", statements, flags=re.S)]
    assert updates == [
        "UPDATE public.moodle_users SET ntfy_confirmed_at = now() "
        "WHERE is_admin AND ntfy_enabled AND ntfy_confirmed_at IS NULL;"
    ]


def test_first_seen_gets_an_epoch_default():
    assert "first_seen     BIGINT" in SQL
    assert "ALTER COLUMN first_seen SET DEFAULT (extract(epoch FROM now()))::bigint;" in SECTION_11


def test_moodle_app_can_read_settings():
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_settings         TO moodle_app;" in SQL
    for key in ("'worker_status'", "'vapid_public_key'"):
        assert key in RAW


def test_section_11_runs_before_the_schema_reload_and_is_logged_in_the_header():
    assert RAW.index(SECTION_11_HEADER) < RAW.index("NOTIFY pgrst, 'reload schema';")
    header = RAW[: RAW.index("-- 0. Dedicated role")]
    assert "11    hardening" in header and "safe to re-run" in header


def test_grade_items_table_follows_the_moodle_app_model():
    assert "ALTER TABLE public.moodle_grade_items ENABLE ROW LEVEL SECURITY;" in SQL
    assert "REVOKE ALL ON public.moodle_grade_items FROM PUBLIC, anon, authenticated;" in SQL
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON public.moodle_grade_items TO moodle_app;" in SQL
    assert "DROP POLICY IF EXISTS moodle_app_all ON public.moodle_grade_items;" in SQL
    assert "CREATE POLICY moodle_app_all ON public.moodle_grade_items" in SQL


def test_grade_items_columns_are_the_worker_contract():
    from supabase_client import GRADE_ITEM_KEYS

    assert _table_columns("moodle_grade_items") == GRADE_COLUMNS
    assert list(GRADE_ITEM_KEYS) == GRADE_COLUMNS


def test_grade_items_are_owned_by_a_user_and_keyed_per_item():
    match = re.search(r"CREATE TABLE IF NOT EXISTS public\.moodle_grade_items \((.*?)\n\);", SQL, flags=re.S)
    assert match, "table moodle_grade_items is not defined"
    table = _ws(match.group(1))
    assert "user_id uuid NOT NULL REFERENCES public.moodle_users(id) ON DELETE CASCADE" in table
    assert "PRIMARY KEY (user_id, course_id, item_id)" in table
    assert "item_type text NOT NULL CHECK (item_type IN ('course', 'category', 'mod', 'manual'))" in table


def test_section_12_follows_section_11_and_precedes_the_schema_reload():
    assert RAW.index(SECTION_11_HEADER) < RAW.index(SECTION_12_HEADER) < RAW.index("NOTIFY pgrst, 'reload schema';")
    header = RAW[: RAW.index("-- 0. Dedicated role")]
    assert "12    grade statistics" in header


def test_section_12_needs_no_migration_of_existing_rows():
    section = _strip_comments(RAW[RAW.index(SECTION_12_HEADER): RAW.index(SECTION_13_HEADER)])
    for forbidden in ("ADD COLUMN", "ADD CONSTRAINT", "UPDATE public.", "DELETE FROM"):
        assert forbidden not in section


SECTION_13_HEADER = "-- 13. Manual exam grades"
SECTION_14_HEADER = "-- 14. Profile photos."


@pytest.mark.parametrize("table", ["moodle_manual_grades", "moodle_avatars"])
def test_sections_13_and_14_follow_the_moodle_app_model(table):
    assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY;" in SQL
    assert f"REVOKE ALL ON public.{table} FROM PUBLIC, anon, authenticated;" in SQL
    assert f"GRANT SELECT, INSERT, UPDATE, DELETE ON public.{table} TO moodle_app;" in SQL
    assert f"DROP POLICY IF EXISTS moodle_app_all ON public.{table};" in SQL
    assert f"CREATE POLICY moodle_app_all ON public.{table}" in SQL


def test_manual_grades_are_one_row_per_course_and_exam_kind():
    match = re.search(r"CREATE TABLE IF NOT EXISTS public\.moodle_manual_grades \((.*?)\n\);", SQL, flags=re.S)
    assert match, "table moodle_manual_grades is not defined"
    table = _ws(match.group(1))
    assert "user_id uuid NOT NULL REFERENCES public.moodle_users(id) ON DELETE CASCADE" in table
    assert "PRIMARY KEY (user_id, course_id, kind)" in table
    assert "kind text NOT NULL CHECK (kind IN ('midterm', 'final'))" in table
    assert "CHECK (grade IS NULL OR grade <= max_points)" in table


def test_avatars_are_bounded_data_urls_owned_by_a_user():
    match = re.search(r"CREATE TABLE IF NOT EXISTS public\.moodle_avatars \((.*?)\n\);", SQL, flags=re.S)
    assert match, "table moodle_avatars is not defined"
    table = _ws(match.group(1))
    assert "user_id uuid PRIMARY KEY REFERENCES public.moodle_users(id) ON DELETE CASCADE" in table
    assert "char_length(image) <= 150000" in table


def test_sections_13_and_14_are_ordered_logged_and_need_no_migration():
    reload_at = RAW.index("NOTIFY pgrst, 'reload schema';")
    assert RAW.index(SECTION_12_HEADER) < RAW.index(SECTION_13_HEADER) < RAW.index(SECTION_14_HEADER) < reload_at
    header = RAW[: RAW.index("-- 0. Dedicated role")]
    assert "13    manual exam grades" in header and "14    profile photos" in header
    section = _strip_comments(RAW[RAW.index(SECTION_13_HEADER): reload_at])
    for forbidden in ("ADD COLUMN", "ADD CONSTRAINT", "UPDATE public.", "DELETE FROM"):
        assert forbidden not in section
