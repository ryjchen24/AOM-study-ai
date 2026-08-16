async def test_health_lists_providers(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["providers"] == ["anthropic", "google", "mistral", "openai"]


async def test_health_needs_no_auth(client):
    assert (await client.get("/api/health")).status_code == 200
