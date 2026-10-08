"""The CI guard in tests/conftest.py: the Web Push tests can never be skipped silently when CI=true."""
import importlib.util
import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
CONFTEST = os.path.join(HERE, "conftest.py")


def _load_conftest():
    spec = importlib.util.spec_from_file_location("devops_conftest_under_test", CONFTEST)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


guard = _load_conftest()


@pytest.mark.parametrize("value,expected", [
    ("true", True), ("TRUE", True), ("1", True), (" true ", True),
    ("", False), ("false", False), ("0", False), (None, False),
])
def test_running_in_ci_reads_the_ci_flag(value, expected):
    env = {} if value is None else {"CI": value}
    assert guard.running_in_ci(env) is expected


def test_missing_push_modules_lists_every_unimportable_library():
    def importer(name):
        if name in ("pywebpush", "cryptography"):
            raise ImportError(name)
        return object()

    assert guard.missing_push_modules(importer) == ["pywebpush", "cryptography"]


def test_missing_push_modules_treats_a_broken_install_as_missing():
    def importer(name):
        if name == "http_ece":
            raise OSError("broken shared library")
        return object()

    assert guard.missing_push_modules(importer) == ["http_ece"]


def test_missing_push_modules_is_empty_when_everything_imports():
    assert guard.missing_push_modules(lambda name: object()) == []


@pytest.mark.parametrize("nodeid,expected", [
    ("tests/test_webpush_sender.py", True),
    ("tests/test_webpush_sender.py::test_send_ok", True),
    ("tests\\test_generate_vapid.py::test_mode[x]", True),
    ("tests/test_delivery.py::test_x", False),
    ("tests/test_webpush_sender_extra.py::test_x", False),
])
def test_is_push_test_matches_only_the_push_modules(nodeid, expected):
    assert guard.is_push_test(nodeid) is expected


# ---- end to end: a real pytest session against a copy of the conftest ---------------------------------------

OK_TEST = "def test_ok():\n    assert True\n"
SKIPPING_TEST = "import pytest\npytest.skip('simulated skip', allow_module_level=True)\n"


def _run_session(tmp_path, ci, broken=(), test_name="test_dummy.py", test_body=OK_TEST):
    """Run pytest in a scratch project; every push library is stubbed, the ``broken`` ones fail to import."""
    project = tmp_path / "project"
    project.mkdir()
    shutil.copyfile(CONFTEST, project / "conftest.py")
    (project / test_name).write_text(test_body, encoding="utf-8")
    stubs = tmp_path / "stub_modules"
    stubs.mkdir()
    for name in guard.PUSH_MODULES:
        body = f"raise ImportError('simulated missing {name}')\n" if name in broken else ""
        (stubs / f"{name}.py").write_text(body, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k not in ("CI", "PYTHONPATH", "PYTEST_ADDOPTS")}
    env["PYTHONPATH"] = str(stubs)
    if ci:
        env["CI"] = "true"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(project)],
        cwd=str(project), env=env, capture_output=True, text=True, timeout=120,
    )
    return result.returncode, result.stdout + result.stderr


def test_ci_session_fails_when_a_push_library_is_missing(tmp_path):
    code, out = _run_session(tmp_path, ci=True, broken=("pywebpush",))
    assert code != 0, out
    assert "Web Push libraries cannot be imported: pywebpush" in out


def test_local_session_still_passes_when_a_push_library_is_missing(tmp_path):
    code, out = _run_session(tmp_path, ci=False, broken=("pywebpush",))
    assert code == 0, out


def test_ci_session_passes_when_every_push_library_imports(tmp_path):
    code, out = _run_session(tmp_path, ci=True)
    assert code == 0, out


def test_ci_session_fails_when_a_push_test_module_skips(tmp_path):
    code, out = _run_session(tmp_path, ci=True, test_name="test_webpush_sender.py", test_body=SKIPPING_TEST)
    assert code != 0, out
    assert "Web Push tests were skipped" in out


def test_local_session_tolerates_a_push_test_module_skip(tmp_path):
    code, out = _run_session(tmp_path, ci=False, test_name="test_webpush_sender.py", test_body=SKIPPING_TEST)
    assert code in (0, 5), out  # 5: no tests ran, which pytest reports when the only module skipped
