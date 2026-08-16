async def create_session(c, **overrides):
    payload = {"title": "Untitled", "model": "claude-sonnet-5", "provider": "anthropic"}
    payload.update(overrides)
    resp = await c.post("/api/sessions", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def create_folder(c, **overrides):
    payload = {"name": "Physics", "color": "#4f46e5"}
    payload.update(overrides)
    return (await c.post("/api/folders", json=payload)).json()


async def test_create_and_list(alice):
    created = await create_session(alice, title="Thermo")
    listed = (await alice.get("/api/sessions")).json()
    assert [s["id"] for s in listed] == [created["id"]]
    assert listed[0]["title"] == "Thermo"


async def test_provider_defaults_to_anthropic(alice):
    resp = await alice.post("/api/sessions", json={"title": "t", "model": "m"})
    assert resp.json()["provider"] == "anthropic"


async def test_list_includes_message_count(alice):
    session = await create_session(alice)
    empty = (await alice.get("/api/sessions")).json()[0]
    assert empty["messageCount"] == 0

    for text in ("hi", "hello"):
        await alice.post(
            f"/api/sessions/{session['id']}/messages",
            json={"role": "user", "text": text},
        )
    assert (await alice.get("/api/sessions")).json()[0]["messageCount"] == 2


async def test_list_is_newest_activity_first(alice):
    older = await create_session(alice, title="older")
    newer = await create_session(alice, title="newer")

    assert [s["title"] for s in (await alice.get("/api/sessions")).json()] == [
        "newer",
        "older",
    ]

    await alice.post(
        f"/api/sessions/{older['id']}/messages", json={"role": "user", "text": "ping"}
    )
    titles = [s["title"] for s in (await alice.get("/api/sessions")).json()]
    assert titles == ["older", "newer"]
    assert newer["id"] is not None


async def test_update_title_and_model(alice):
    session = await create_session(alice)
    resp = await alice.patch(
        f"/api/sessions/{session['id']}",
        json={"title": "Renamed", "model": "gpt-4o"},
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Renamed"
    assert resp.json()["model"] == "gpt-4o"


async def test_empty_update_is_a_400(alice):
    session = await create_session(alice)
    assert (await alice.patch(f"/api/sessions/{session['id']}", json={})).status_code == 400


async def test_move_into_own_folder(alice):
    folder = await create_folder(alice)
    session = await create_session(alice)
    resp = await alice.patch(
        f"/api/sessions/{session['id']}", json={"folderId": folder["id"]}
    )
    assert resp.status_code == 200
    assert resp.json()["folderId"] == folder["id"]


async def test_delete_removes_it(alice):
    session = await create_session(alice)
    assert (await alice.delete(f"/api/sessions/{session['id']}")).status_code == 200
    assert (await alice.get("/api/sessions")).json() == []


async def test_missing_session_is_404(alice):
    assert (await alice.patch("/api/sessions/nope", json={"title": "x"})).status_code == 404
    assert (await alice.delete("/api/sessions/nope")).status_code == 404


async def test_invalid_body_is_422(alice):
    assert (await alice.post("/api/sessions", json={"title": "t"})).status_code == 422


async def test_list_only_returns_your_own_sessions(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        await create_session(a, title="A's chat")
    async with auth_client(user_b) as b:
        assert (await b.get("/api/sessions")).json() == []


async def test_cannot_mutate_another_users_session(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        victim = await create_session(a, title="A's chat")

    async with auth_client(user_b) as b:
        assert (await b.patch(f"/api/sessions/{victim['id']}", json={"title": "hax"})).status_code == 404
        assert (await b.delete(f"/api/sessions/{victim['id']}")).status_code == 404

    async with auth_client(user_a) as a:
        assert (await a.get("/api/sessions")).json()[0]["title"] == "A's chat"


async def test_cannot_file_a_session_into_another_users_folder(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        victim_folder = await create_folder(a)

    async with auth_client(user_b) as b:
        resp = await b.post(
            "/api/sessions",
            json={"title": "t", "model": "m", "folderId": victim_folder["id"]},
        )
        assert resp.status_code == 404

        mine = await create_session(b)
        resp = await b.patch(
            f"/api/sessions/{mine['id']}", json={"folderId": victim_folder["id"]}
        )
        assert resp.status_code == 404
