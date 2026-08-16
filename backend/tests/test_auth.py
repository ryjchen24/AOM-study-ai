import base64
import json

import itsdangerous
import pytest

from conftest import COOKIE_DOMAIN, session_cookie

PROTECTED = [
    ("GET", "/api/auth/me"),
    ("GET", "/api/folders"),
    ("POST", "/api/folders"),
    ("PATCH", "/api/folders/some-id"),
    ("DELETE", "/api/folders/some-id"),
    ("GET", "/api/sessions"),
    ("POST", "/api/sessions"),
    ("PATCH", "/api/sessions/some-id"),
    ("DELETE", "/api/sessions/some-id"),
    ("GET", "/api/sessions/some-id/messages"),
    ("POST", "/api/sessions/some-id/messages"),
    ("PATCH", "/api/messages/some-id"),
    ("DELETE", "/api/messages"),
    ("GET", "/api/keys"),
    ("POST", "/api/keys"),
    ("DELETE", "/api/keys/some-id"),
    ("POST", "/api/keys/some-id/test"),
    ("POST", "/api/chat"),
]


@pytest.mark.parametrize("method,path", PROTECTED)
async def test_protected_routes_reject_anonymous(client, method, path):
    resp = await client.request(method, path, json={})
    assert resp.status_code == 401, f"{method} {path} returned {resp.status_code}"


async def test_me_returns_the_signed_in_user(alice, user):
    resp = await alice.get("/api/auth/me")
    assert resp.status_code == 200
    assert resp.json() == {
        "id": user.id,
        "email": user.email,
        "displayName": user.displayName,
        "avatarUrl": user.avatarUrl,
        "createdAt": resp.json()["createdAt"],
    }


async def test_me_never_exposes_internal_fields(alice):
    body = await (alice.get("/api/auth/me"))
    assert set(body.json()) == {"id", "email", "displayName", "avatarUrl", "createdAt"}
    assert "googleId" not in body.text


async def test_cookie_signed_with_wrong_secret_is_rejected(client, user):
    forged = itsdangerous.TimestampSigner("not-the-real-secret")
    data = base64.b64encode(json.dumps({"user_id": user.id}).encode())
    client.cookies.set(
        "studyai_session", forged.sign(data).decode(), domain=COOKIE_DOMAIN
    )
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_session_for_deleted_user_is_rejected(client, user, _db):
    client.cookies.set("studyai_session", session_cookie(user.id), domain=COOKIE_DOMAIN)
    assert (await client.get("/api/auth/me")).status_code == 200

    await _db.user.delete(where={"id": user.id})

    assert (await client.get("/api/auth/me")).status_code == 401


async def test_logout_clears_the_session(alice):
    assert (await alice.post("/api/auth/logout")).json() == {"ok": True}
    assert (await alice.get("/api/auth/me")).status_code == 401


async def test_google_login_is_503_when_not_configured(client):
    resp = await client.get("/api/auth/google/login")
    assert resp.status_code == 503
    assert "not configured" in resp.json()["detail"]


async def test_google_callback_is_503_when_not_configured(client):
    assert (await client.get("/api/auth/google/callback")).status_code == 503
