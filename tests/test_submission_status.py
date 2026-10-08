import pytest

from moodle_client import MoodleClient, parse_submission_status


def _page(status_cell: str, label: str = "Estado de la entrega") -> str:
    return f"""
    <html><body>
    <div class="submissionstatustable">
      <div class="box generalbox boxaligncenter submissionsummarytable">
        <table class="generaltable">
          <tr><th>{label}</th>{status_cell}</tr>
          <tr><th>Estado de la calificación</th><td class="cell c1">Sin calificar</td></tr>
        </table>
      </div>
    </div>
    </body></html>
    """


def test_submitted_spanish_by_class():
    html = _page('<td class="submissionstatussubmitted cell c1">Enviado para calificar</td>')
    assert parse_submission_status(html) == "submitted"


def test_submitted_english_by_class():
    html = _page(
        '<td class="submissionstatussubmitted cell c1">Submitted for grading</td>',
        label="Submission status",
    )
    assert parse_submission_status(html) == "submitted"


def test_submitted_text_fallback_without_class():
    assert parse_submission_status(_page('<td class="cell c1">Enviado para calificar</td>')) == "submitted"
    assert parse_submission_status(
        _page('<td class="cell c1">Submitted for grading</td>', label="Submission status")
    ) == "submitted"


def test_draft_by_class():
    html = _page('<td class="submissionstatusdraft cell c1">Borrador (no enviado)</td>')
    assert parse_submission_status(html) == "pending"


def test_new_by_class():
    html = _page('<td class="submissionstatusnew cell c1">No se ha enviado nada</td>')
    assert parse_submission_status(html) == "pending"


@pytest.mark.parametrize("text", ["Borrador (no enviado)", "No entregado", "No se ha enviado nada", "Not submitted"])
def test_pending_text_fallback(text):
    assert parse_submission_status(_page(f'<td class="cell c1">{text}</td>')) == "pending"


def test_unknown_page_returns_none():
    assert parse_submission_status("<html><body><h1>Login</h1></body></html>") is None
    assert parse_submission_status("") is None


def test_table_with_unrecognised_text_returns_none():
    assert parse_submission_status(_page('<td class="cell c1">???</td>')) is None


class _Resp:
    def __init__(self, text="", status_code=200, url="https://m.example/mod/assign/view.php?id=1"):
        self.text = text
        self.status_code = status_code
        self.url = url


def test_fetch_submission_status_never_raises(monkeypatch):
    client = MoodleClient("https://m.example", "abc")

    def boom(*a, **k):
        raise RuntimeError("network down")

    monkeypatch.setattr(client.http, "get", boom)
    assert client.fetch_submission_status("https://m.example/mod/assign/view.php?id=1") is None
    # non-assignment URLs are never requested
    assert client.fetch_submission_status("https://m.example/mod/quiz/view.php?id=1") is None


def test_fetch_submission_status_login_redirect_is_unknown(monkeypatch):
    client = MoodleClient("https://m.example", "abc")
    monkeypatch.setattr(
        client.http, "get", lambda *a, **k: _Resp("x", url="https://m.example/login/index.php")
    )
    assert client.fetch_submission_status("https://m.example/mod/assign/view.php?id=1") is None


def test_enrich_overrides_only_when_detected(monkeypatch):
    client = MoodleClient("https://m.example", "abc")
    answers = {
        "https://m.example/mod/assign/view.php?id=1": "submitted",
        "https://m.example/mod/assign/view.php?id=2": None,
    }
    monkeypatch.setattr(client, "fetch_submission_status", lambda url: answers.get(url))
    tasks = [
        {"id": "a", "status": "pending", "task_url": "https://m.example/mod/assign/view.php?id=1"},
        {"id": "b", "status": "pending", "task_url": "https://m.example/mod/assign/view.php?id=2"},
        {"id": "c", "status": "pending", "task_url": "https://m.example/mod/quiz/view.php?id=3"},
    ]
    client.enrich_submission_status(tasks, delay=0)
    assert tasks[0]["status"] == "submitted" and tasks[0]["status_source"] == "assignment_page"
    assert tasks[1]["status"] == "pending" and "status_source" not in tasks[1]
    assert tasks[2]["status"] == "pending"
