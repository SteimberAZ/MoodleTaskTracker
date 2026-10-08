"""Generate a long-lived HS256 JWT with claim role=moodle_app.

The signing secret is the Supabase instance JWT secret. It is read from an
environment variable (default JWT_SECRET) and never from the command line, so
it does not end up in shell history or the process list.

    JWT_SECRET=... python scripts/make_moodle_jwt.py [--years 5] [--secret-env NAME]

Only the token is printed to stdout.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
from typing import Optional

MIN_SECRET_LEN = 32
ROLE = "moodle_app"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_token(secret: str, years: int = 5, now: Optional[int] = None) -> str:
    iat = int(time.time()) if now is None else int(now)
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {"role": ROLE, "iss": "supabase", "iat": iat, "exp": iat + int(years * 365 * 86400)}
    signing_input = ".".join(
        _b64url(json.dumps(part, separators=(",", ":")).encode("utf-8")) for part in (header, claims)
    )
    sig = hmac.new(secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(sig)}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--years", type=int, default=5, help="validity in years (default 5)")
    parser.add_argument("--secret-env", default="JWT_SECRET", help="env var holding the JWT secret")
    args = parser.parse_args(argv)

    secret = os.environ.get(args.secret_env, "")
    if len(secret) < MIN_SECRET_LEN:
        print(
            f"error: set {args.secret_env} to the instance JWT secret (at least {MIN_SECRET_LEN} chars)",
            file=sys.stderr,
        )
        return 2
    if args.years < 1:
        print("error: --years must be >= 1", file=sys.stderr)
        return 2
    print(make_token(secret, args.years))
    return 0


if __name__ == "__main__":
    sys.exit(main())
