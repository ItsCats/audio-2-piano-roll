"""
Request authentication.

The browser never sees SHARED_SECRET. The Netlify function `backend-token` mints a
short-lived token `base64url(payload).base64url(HMAC-SHA256(secret, payload))` where
payload = {"exp": <unix seconds>, "nonce": "..."}; this server verifies it.
For purely local use you may set ALLOW_ANONYMOUS=1 instead.
"""
import base64
import hashlib
import hmac
import json
import time

from fastapi import Header, HTTPException

from .config import settings


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_token(token: str) -> bool:
    if not settings.shared_secret:
        return False
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        expected = hmac.new(settings.shared_secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64d(sig_b64)):
            return False
        payload = json.loads(_b64d(payload_b64))
        return float(payload.get("exp", 0)) > time.time()
    except Exception:  # noqa: BLE001 - any malformed token is simply invalid
        return False


async def require_auth(authorization: str | None = Header(default=None)) -> None:
    if settings.allow_anonymous:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing access token")
    if not verify_token(authorization[7:]):
        raise HTTPException(status_code=401, detail="Invalid or expired access token")
