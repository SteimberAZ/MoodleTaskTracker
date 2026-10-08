"""Generate the VAPID key pair for native Web Push.

    python scripts/generate_vapid.py [--out ./vapid_private.pem] [--force]

The PRIVATE key is written to a PEM file (mode 600 where the OS supports it) and is never printed:
keep it on the VPS and point VAPID_PRIVATE_KEY_FILE at it. Only the PUBLIC key goes to stdout, as
base64url of the uncompressed P-256 point (87 characters, no padding), followed by the line to put in
the web app's environment (Vercel). Messages for humans go to stderr.

An existing file is never overwritten unless --force is given: replacing the key invalidates every
push subscription created with the old one.
"""
import argparse
import base64
import errno
import os
import sys
from typing import Optional, Tuple

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(PROJECT_DIR, "vapid_private.pem")


def generate_keypair() -> Tuple[bytes, str]:
    """A fresh P-256 key as (private key PEM, public key as base64url without padding)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    point = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return pem, base64.urlsafe_b64encode(point).rstrip(b"=").decode("ascii")


def write_private_key(path: str, pem: bytes, force: bool = False) -> None:
    """Write ``pem`` readable by the owner only; raises FileExistsError unless ``force``."""
    parent = os.path.dirname(os.path.abspath(path))
    try:
        os.makedirs(parent, exist_ok=True)
    except FileExistsError:  # a regular file sits where the directory should be
        raise NotADirectoryError(errno.ENOTDIR, os.strerror(errno.ENOTDIR), parent) from None
    flags =os.O_WRONLY | os.O_CREAT | getattr(os, "O_BINARY", 0) | (os.O_TRUNC if force else os.O_EXCL)
    fd = os.open(path, flags, 0o600)  # the mode applies at creation, so the key is never world-readable
    with os.fdopen(fd, "wb") as fh:
        fh.write(pem)
    try:
        os.chmod(path, 0o600)  # also tightens a file that --force overwrites
    except OSError:
        pass


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=DEFAULT_OUT, help="where to write the private key PEM (default: vapid_private.pem in the project)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing key file")
    args = parser.parse_args(argv)

    try:
        pem, public_key = generate_keypair()
    except ImportError:
        print("error: the 'cryptography' package is required (pip install -r requirements-worker.txt)", file=sys.stderr)
        return 2
    try:
        write_private_key(args.out, pem, args.force)
    except FileExistsError:
        print(f"error: {args.out} already exists; pass --force to replace it "
              "(every push subscription made with the old key stops working)", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: cannot write {args.out}: {exc.strerror or type(exc).__name__}", file=sys.stderr)
        return 2

    print(f"private key written to {os.path.abspath(args.out)} (keep it on the VPS; never commit it)", file=sys.stderr)
    print(public_key)
    print(f"NEXT_PUBLIC_VAPID_PUBLIC_KEY={public_key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
