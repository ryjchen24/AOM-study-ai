import base64
import json
import os
import sys
from pathlib import Path

import itsdangerous
import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

BASE_URL = "http://testserver"
COOKIE_DOMAIN = "testserver.local"

TEST_SESSION_SECRET = "test-session-secret-not-used-anywhere-real"
TEST_KEY_ENCRYPTION_KEY = "QU1PLVRFU1QtS0VZLURPLU5PVC1VU0UtSU4tUFJPRCE="

DEFAULT_TEST_DATABASE_URL = "postgresql://studyai@localhost:5432/studyai_test"
DATABASE_URL = os.environ.get("TEST_DATABASE_URL") or DEFAULT_TEST_DATABASE_URL

_db_name = DATABASE_URL.rsplit("/", 1)[-1].split("?")[0]
if not _db_name.endswith("_test"):
    raise RuntimeError(
        f"Refusing to run tests against database {_db_name!r}: the suite wipes "
        "every table between tests, so the database name must end in '_test'. "
        "Set TEST_DATABASE_URL to a throwaway database."
    )

os.environ["DATABASE_URL"] = DATABASE_URL
os.environ["SESSION_SECRET"] = TEST_SESSION_SECRET
os.environ["KEY_ENCRYPTION_KEY"] = TEST_KEY_ENCRYPTION_KEY
os.environ["COOKIE_SECURE"] = "false"
os.environ["FRONTEND_URL"] = "http://testserver"
os.environ["GOOGLE_CLIENT_ID"] = ""
os.environ["GOOGLE_CLIENT_SECRET"] = ""

from httpx import ASGITransport, AsyncClient  # noqa: E402

import main  # noqa: E402

_TABLES = '"Message", "Session", "Folder", "UserApiKey", "User"'


@pytest.fixture(scope="session", autouse=True)
async def _db():
    await main.prisma.connect()
    try:
        yield main.prisma
    finally:
        await main.prisma.disconnect()


@pytest.fixture(autouse=True)
async def _clean_db(_db):
    await _db.execute_raw(f"TRUNCATE TABLE {_TABLES} RESTART IDENTITY CASCADE")
    yield


@pytest.fixture(autouse=True)
def _no_rate_limit():
    main.limiter.enabled = False
    yield
    main.limiter.enabled = True


@pytest.fixture
async def client():
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url=BASE_URL) as c:
        yield c


def session_cookie(user_id: str) -> str:
    signer = itsdangerous.TimestampSigner(TEST_SESSION_SECRET)
    data = base64.b64encode(json.dumps({"user_id": user_id}).encode("utf-8"))
    return signer.sign(data).decode("utf-8")


@pytest.fixture
async def make_user(_db):
    counter = {"n": 0}

    async def _make(**overrides):
        counter["n"] += 1
        n = counter["n"]
        data = {
            "googleId": f"google-sub-{n}",
            "email": f"user{n}@example.com",
            "displayName": f"Test User {n}",
            "avatarUrl": f"https://example.com/avatar{n}.png",
        }
        data.update(overrides)
        return await _db.user.create(data=data)

    return _make


@pytest.fixture
async def auth_client(make_user):
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _client(user):
        transport = ASGITransport(app=main.app)
        async with AsyncClient(transport=transport, base_url=BASE_URL) as c:
            c.cookies.set(
                "studyai_session", session_cookie(user.id), domain=COOKIE_DOMAIN
            )
            yield c

    return _client


@pytest.fixture
async def user(make_user):
    return await make_user()


@pytest.fixture
async def alice(user, auth_client):
    async with auth_client(user) as c:
        yield c
