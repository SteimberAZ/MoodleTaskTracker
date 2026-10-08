"""deploy/ecosystem.config.js loads in Node and describes the worker the way the deploy runbook expects."""
import json
import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ECOSYSTEM = os.path.join(ROOT, "deploy", "ecosystem.config.js")


@pytest.fixture(scope="module")
def app():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    script = "process.stdout.write(JSON.stringify(require(process.argv[1])))"
    out = subprocess.run([node, "-e", script, ECOSYSTEM], capture_output=True, text=True, timeout=60, check=True)
    config = json.loads(out.stdout)
    assert len(config["apps"]) == 1
    return config["apps"][0]


def test_runs_the_worker_from_the_repository_root_with_the_venv_python(app):
    assert app["name"] == "utm-moodle-tracker"
    assert os.path.normpath(app["cwd"]) == os.path.normpath(ROOT)
    assert os.path.normpath(app["script"]) == os.path.join(ROOT, "worker.py")
    assert os.path.normpath(app["interpreter"]) == os.path.join(ROOT, "venv", "bin", "python")


def test_only_sets_unbuffered_output_in_the_environment(app):
    assert app["env"] == {"PYTHONUNBUFFERED": "1"}


def test_logging_and_shutdown_settings(app):
    assert app["time"] is True
    assert app["log_date_format"] == "YYYY-MM-DDTHH:mm:ssZ"
    assert app["kill_timeout"] == 10000
    assert app["autorestart"] is True
    assert app["exp_backoff_restart_delay"] == 5000
    assert "max_restarts" not in app
