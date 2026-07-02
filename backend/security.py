"""Symmetric encryption for user API keys (BYOK).

The whole point: a stored provider key must never sit in Postgres in plaintext.
We encrypt with Fernet (AES-128-CBC + HMAC) using ONE server-wide master key,
`KEY_ENCRYPTION_KEY`, kept only in backend/.env.

Hard rules (each is a real way people leak keys):
  - Plaintext keys live in process memory for the lifetime of ONE request only.
    Callers must not cache them, stash them on request.state, or log them.
  - NEVER log the plaintext OR the ciphertext, and never put either in an error
    message / exception argument that could be echoed back to a client.
  - `encrypt_key` / `decrypt_key` are the only place the master key is touched.
"""

import os

from cryptography.fernet import Fernet
from dotenv import load_dotenv

# security.py may be imported before main.py calls load_dotenv(), so load here
# too — python-dotenv is idempotent and won't clobber already-set env vars.
load_dotenv()

# Fail fast on a missing/invalid master key rather than limp along and only blow
# up on the first chat call. A wrong key here means every stored key is unusable.
_MASTER_KEY = os.environ.get("KEY_ENCRYPTION_KEY")
if not _MASTER_KEY:
    raise RuntimeError(
        "KEY_ENCRYPTION_KEY is not set. Generate one with "
        "`python -c \"from cryptography.fernet import Fernet; "
        "print(Fernet.generate_key().decode())\"` and add it to backend/.env"
    )

try:
    _fernet = Fernet(_MASTER_KEY.encode())
except (ValueError, TypeError) as exc:
    # The message intentionally says nothing about the key's contents.
    raise RuntimeError(
        "KEY_ENCRYPTION_KEY is not a valid Fernet key (expected a 32-byte "
        "url-safe base64 string). Regenerate it — see backend/.env."
    ) from exc


def encrypt_key(plaintext: str) -> bytes:
    """Encrypt a plaintext API key. Returns Fernet ciphertext (opaque bytes).

    Store the return value directly in `UserApiKey.encryptedKey`. With Prisma
    Client Python's `Bytes` field, wrap it at the call site as
    `Base64.encode(encrypt_key(...))`.
    """
    return _fernet.encrypt(plaintext.encode())


def decrypt_key(ciphertext: bytes) -> str:
    """Decrypt ciphertext produced by `encrypt_key` back to the plaintext key.

    Raises `cryptography.fernet.InvalidToken` if the data was tampered with or
    was encrypted under a different master key. The exception carries no key
    material, so it is safe to surface as a generic 500 — never re-raise it with
    the plaintext or ciphertext attached.
    """
    return _fernet.decrypt(ciphertext).decode()
