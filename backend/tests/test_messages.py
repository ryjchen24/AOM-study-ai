from test_sessions import create_session


async def post_message(c, session_id, **overrides):
    payload = {"role": "user", "text": "hello"}
    payload.update(overrides)
    return await c.post(f"/api/sessions/{session_id}/messages", json=payload)


async def test_create_and_list_in_chronological_order(alice):
    session = await create_session(alice)
    for text in ("first", "second", "third"):
        assert (await post_message(alice, session["id"], text=text)).status_code == 200

    listed = (await alice.get(f"/api/sessions/{session['id']}/messages")).json()
    assert [m["text"] for m in listed] == ["first", "second", "third"]


async def test_assistant_role_is_accepted(alice):
    session = await create_session(alice)
    resp = await post_message(alice, session["id"], role="assistant", text="sure")
    assert resp.status_code == 200
    assert resp.json()["role"] == "assistant"


async def test_unknown_role_is_422(alice):
    session = await create_session(alice)
    assert (await post_message(alice, session["id"], role="system")).status_code == 422


async def test_attachments_round_trip(alice):
    session = await create_session(alice)
    attachment = {
        "name": "notes.txt",
        "mime": "text/plain",
        "kind": "text",
        "data": "chapter 4 summary",
    }
    resp = await post_message(alice, session["id"], attachments=[attachment])
    assert resp.status_code == 200

    listed = (await alice.get(f"/api/sessions/{session['id']}/messages")).json()
    assert listed[0]["attachments"] == [attachment]


async def test_message_without_attachments_stores_null(alice):
    session = await create_session(alice)
    await post_message(alice, session["id"])
    assert (await alice.get(f"/api/sessions/{session['id']}/messages")).json()[0][
        "attachments"
    ] is None


async def test_bulk_delete(alice):
    session = await create_session(alice)
    ids = [
        (await post_message(alice, session["id"], text=t)).json()["id"]
        for t in ("a", "b", "c")
    ]

    resp = await alice.request("DELETE", "/api/messages", json={"ids": ids[:2]})
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 2}

    remaining = (await alice.get(f"/api/sessions/{session['id']}/messages")).json()
    assert [m["text"] for m in remaining] == ["c"]


async def test_bulk_delete_rejects_an_empty_list(alice):
    resp = await alice.request("DELETE", "/api/messages", json={"ids": []})
    assert resp.status_code == 400


async def test_deleting_a_session_cascades_to_its_messages(alice, _db):
    session = await create_session(alice)
    await post_message(alice, session["id"])
    await alice.delete(f"/api/sessions/{session['id']}")
    assert await _db.message.count(where={"sessionId": session["id"]}) == 0


async def test_messages_of_a_missing_session_are_404(alice):
    assert (await alice.get("/api/sessions/nope/messages")).status_code == 404
    assert (await post_message(alice, "nope")).status_code == 404


async def test_cannot_read_another_users_messages(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        session = await create_session(a)
        await post_message(a, session["id"], text="private")

    async with auth_client(user_b) as b:
        assert (await b.get(f"/api/sessions/{session['id']}/messages")).status_code == 404


async def test_cannot_write_into_another_users_session(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        session = await create_session(a)

    async with auth_client(user_b) as b:
        assert (await post_message(b, session["id"], text="injected")).status_code == 404

    async with auth_client(user_a) as a:
        assert (await a.get(f"/api/sessions/{session['id']}/messages")).json() == []


async def test_bulk_delete_silently_skips_other_users_ids(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        a_session = await create_session(a)
        a_message = (await post_message(a, a_session["id"], text="A's")).json()

    async with auth_client(user_b) as b:
        b_session = await create_session(b)
        b_message = (await post_message(b, b_session["id"], text="B's")).json()

        resp = await b.request(
            "DELETE", "/api/messages", json={"ids": [a_message["id"], b_message["id"]]}
        )
        assert resp.json() == {"deleted": 1}

    async with auth_client(user_a) as a:
        remaining = (await a.get(f"/api/sessions/{a_session['id']}/messages")).json()
        assert [m["text"] for m in remaining] == ["A's"]
