"""scripts/generate_vapid.py: output contract, private key file handling and the .gitignore guard."""
import base64
import os
import re
import stat
import sys

import pytest

pytest.importorskip("cryptography")
from cryptography.hazmat.primitives import serialization  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import generate_vapid as gv  # noqa: E402


def _decode(b64url):
    return base64.urlsafe_b64decode(b64url + "=" * (-len(b64url) % 4))


def _public_point(pem_bytes):
    key = serialization.load_pem_private_key(pem_bytes, password=None)
    return key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def test_prints_only_the_public_key_and_writes_the_private_pem(tmp_path, capsys):
    out = tmp_path / "vapid_private.pem"
    assert gv.main(["--out", str(out)]) == 0

    captured = capsys.readouterr()
    lines = captured.out.splitlines()
    public = lines[0]
    assert re.fullmatch(r"[A-Za-z0-9_-]{87}", public)  # base64url, no padding
    raw = _decode(public)
    assert len(raw) == 65 and raw[0] == 0x04  # uncompressed P-256 point
    assert lines[1:] == [f"NEXT_PUBLIC_VAPID_PUBLIC_KEY={public}"]
    assert "PRIVATE" not in captured.out and "BEGIN" not in captured.out

    pem = out.read_bytes()
    assert pem.startswith(b"-----BEGIN PRIVATE KEY-----")
    assert _public_point(pem) == raw  # the printed key belongs to the stored private key
    assert "vapid_private.pem" in captured.err  # the human note goes to stderr


def test_every_run_generates_a_new_key(tmp_path, capsys):
    gv.main(["--out", str(tmp_path / "a.pem")])
    gv.main(["--out", str(tmp_path / "b.pem")])
    first, second = capsys.readouterr().out.splitlines()[::2]
    assert first != second


def test_refuses_to_overwrite_without_force(tmp_path, capsys):
    out = tmp_path / "vapid_private.pem"
    assert gv.main(["--out", str(out)]) == 0
    capsys.readouterr()
    original = out.read_bytes()

    assert gv.main(["--out", str(out)]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""  # nothing that looks like a key is printed
    assert "--force" in captured.err
    assert out.read_bytes() == original

    assert gv.main(["--out", str(out), "--force"]) == 0
    assert out.read_bytes() != original
    assert _public_point(out.read_bytes()) == _decode(capsys.readouterr().out.splitlines()[0])


def test_creates_missing_parent_directories(tmp_path):
    out = tmp_path / "secrets" / "nested" / "k.pem"
    assert gv.main(["--out", str(out)]) == 0
    assert out.is_file()


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_private_key_is_owner_only(tmp_path):
    out = tmp_path / "k.pem"
    gv.main(["--out", str(out)])
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    out.chmod(0o644)
    gv.main(["--out", str(out), "--force"])
    assert stat.S_IMODE(out.stat().st_mode) == 0o600


def test_default_output_is_the_project_key_file(monkeypatch):
    assert gv.DEFAULT_OUT == os.path.join(ROOT, "vapid_private.pem")
    seen = {}
    monkeypatch.setattr(gv, "write_private_key", lambda path, pem, force=False: seen.update(path=path))
    assert gv.main([]) == 0
    assert seen["path"] == gv.DEFAULT_OUT


def test_missing_cryptography_is_reported_with_a_hint(monkeypatch, capsys):
    def no_cryptography():
        raise ImportError("No module named 'cryptography'")

    monkeypatch.setattr(gv, "generate_keypair", no_cryptography)
    assert gv.main(["--out", "unused.pem"]) == 2
    captured = capsys.readouterr()
    assert captured.out == "" and "cryptography" in captured.err


def test_unwritable_target_is_reported_not_raised(tmp_path, capsys):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert gv.main(["--out", str(blocker / "k.pem")]) == 2  # parent "directory" is a file
    assert capsys.readouterr().out == ""


def test_gitignore_keeps_private_keys_out_of_git():
    with open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as fh:
        rules = fh.read().split()
    assert "vapid_private.pem" in rules and "*.pem" in rules
