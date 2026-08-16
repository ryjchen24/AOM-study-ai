import httpx
import pytest

import providers
import security

OPENAI_KEY = "sk-" + "T" * 40
ANTHROPIC_KEY = "sk-ant-" + "T" * 40
GOOGLE_KEY = "AIza" + "T" * 35
MISTRAL_KEY = "T" * 32


async def add_key(c, provider="openai", key=OPENAI_KEY, label=None):
    payload = {"provider": provider, "apiKey": key}
    if label is not None:
        payload["label"] = label
    return await c.post("/api/keys", json=payload)


async def test_create_returns_only_safe_fields(alice):
    resp = await add_key(alice, label="personal")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"id", "provider", "label", "last4"}
    assert body["provider"] == "openai"
    assert body["label"] == "personal"
    assert body["last4"] == OPENAI_KEY[-4:]


async def test_plaintext_key_never_comes_back_over_http(alice):
    await add_key(alice)
    listed = await alice.get("/api/keys")
    assert OPENAI_KEY not in listed.text
    assert "encryptedKey" not in listed.text


async def test_key_is_encrypted_at_rest(alice, user, _db):
    await add_key(alice)
    row = await _db.userapikey.find_first(where={"userId": user.id})

    ciphertext = row.encryptedKey.decode()
    assert OPENAI_KEY.encode() not in ciphertext
    assert security.decrypt_key(ciphertext) == OPENAI_KEY


@pytest.mark.parametrize(
    "provider,key",
    [
        ("openai", OPENAI_KEY),
        ("anthropic", ANTHROPIC_KEY),
        ("google", GOOGLE_KEY),
        ("mistral", MISTRAL_KEY),
    ],
)
async def test_every_provider_accepts_a_well_shaped_key(alice, provider, key):
    assert (await add_key(alice, provider=provider, key=key)).status_code == 200


@pytest.mark.parametrize(
    "provider,key",
    [
        ("openai", "pk-wrong-prefix"),
        ("anthropic", OPENAI_KEY),
        ("google", "not-a-google-key"),
        ("mistral", "tooshort"),
    ],
)
async def test_obviously_wrong_key_shapes_are_rejected(alice, provider, key):
    resp = await add_key(alice, provider=provider, key=key)
    assert resp.status_code == 400
    assert key not in resp.text


async def test_unknown_provider_is_422(alice):
    assert (await add_key(alice, provider="ollama", key="x" * 40)).status_code == 422


async def test_blank_key_is_rejected(alice):
    assert (await add_key(alice, key="   ")).status_code == 400


async def test_overlong_key_is_rejected_without_echoing_it(alice):
    huge = "sk-" + "T" * 400
    resp = await add_key(alice, key=huge)
    assert resp.status_code == 400
    assert "too long" in resp.json()["detail"]
    assert huge not in resp.text


async def test_duplicate_provider_and_label_is_409(alice):
    assert (await add_key(alice, label="work")).status_code == 200
    assert (await add_key(alice, label="work")).status_code == 409


async def test_duplicate_with_no_label_is_also_409(alice):
    assert (await add_key(alice)).status_code == 200
    assert (await add_key(alice)).status_code == 409


async def test_different_labels_can_coexist(alice):
    assert (await add_key(alice, label="personal")).status_code == 200
    assert (await add_key(alice, label="work")).status_code == 200
    assert len((await alice.get("/api/keys")).json()) == 2


async def test_delete_removes_the_key(alice):
    key = (await add_key(alice)).json()
    assert (await alice.delete(f"/api/keys/{key['id']}")).json() == {"deleted": 1}
    assert (await alice.get("/api/keys")).json() == []


async def test_deleting_a_missing_key_is_404(alice):
    assert (await alice.delete("/api/keys/nope")).status_code == 404


async def test_test_endpoint_reports_a_working_key(alice, monkeypatch):
    key = (await add_key(alice)).json()

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"data": []})

    monkeypatch.setattr(
        providers, "_make_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    assert (await alice.post(f"/api/keys/{key['id']}/test")).json() == {"ok": True}
    assert seen["auth"] == f"Bearer {OPENAI_KEY}"
    assert OPENAI_KEY not in seen["url"]


async def test_test_endpoint_surfaces_a_rejected_key_without_leaking_it(alice, monkeypatch):
    key = (await add_key(alice)).json()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text=f"Incorrect API key provided: {OPENAI_KEY}")

    monkeypatch.setattr(
        providers, "_make_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )

    resp = await alice.post(f"/api/keys/{key['id']}/test")
    body = resp.json()
    assert body["ok"] is False
    assert "401" in body["error"]
    assert OPENAI_KEY not in resp.text
    assert "***" in body["error"]


async def test_testing_a_missing_key_is_404(alice):
    assert (await alice.post("/api/keys/nope/test")).status_code == 404


async def test_keys_are_scoped_to_their_owner(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        await add_key(a)
    async with auth_client(user_b) as b:
        assert (await b.get("/api/keys")).json() == []


async def test_cannot_delete_or_test_another_users_key(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        victim = (await add_key(a)).json()

    async with auth_client(user_b) as b:
        assert (await b.delete(f"/api/keys/{victim['id']}")).status_code == 404
        assert (await b.post(f"/api/keys/{victim['id']}/test")).status_code == 404

    async with auth_client(user_a) as a:
        assert len((await a.get("/api/keys")).json()) == 1
