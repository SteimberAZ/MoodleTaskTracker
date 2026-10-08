import importlib
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# The Web Push tests skip themselves (module-level importorskip) when these libraries are missing,
# which is fine on a dev box but would let CI go green without testing the push path at all.
PUSH_MODULES = ("pywebpush", "http_ece", "py_vapid", "cryptography")
# Test modules whose skips are never acceptable in CI (all of their tests exercise the push chain).
PUSH_TEST_FILES = ("test_webpush_sender.py", "test_generate_vapid.py")


def running_in_ci(env=None) -> bool:
    """True when the CI env var is set the way GitHub Actions (and most CI services) set it."""
    env = os.environ if env is None else env
    return str(env.get("CI", "")).strip().lower() in ("true", "1")


def missing_push_modules(importer=importlib.import_module) -> list:
    """Names of the Web Push libraries that cannot be imported."""
    missing = []
    for name in PUSH_MODULES:
        try:
            importer(name)
        except Exception:  # ImportError, or a broken install raising something else on import
            missing.append(name)
    return missing


def is_push_test(nodeid: str) -> bool:
    path = nodeid.split("::", 1)[0].replace("\\", "/")
    return path.rsplit("/", 1)[-1] in PUSH_TEST_FILES


_push_skips = []


def pytest_sessionstart(session):
    if not running_in_ci():
        return
    missing = missing_push_modules()
    if missing:
        pytest.exit(
            "CI=true but the Web Push libraries cannot be imported: " + ", ".join(missing)
            + ". Install requirements-dev.txt (it includes requirements-worker.txt); the push tests "
            "must run in CI, never skip.",
            returncode=1,
        )


def pytest_collectreport(report):
    if report.skipped and is_push_test(report.nodeid):
        _push_skips.append(report.nodeid)


def pytest_runtest_logreport(report):
    if report.skipped and is_push_test(report.nodeid):
        _push_skips.append(report.nodeid)


def pytest_sessionfinish(session, exitstatus):
    if not running_in_ci() or not _push_skips:
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is not None:
        reporter.write_line(
            "CI=true: Web Push tests were skipped, failing the run: " + ", ".join(sorted(set(_push_skips))),
            red=True,
        )
    session.exitstatus = pytest.ExitCode.TESTS_FAILED
