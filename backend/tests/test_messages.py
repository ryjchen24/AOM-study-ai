import asyncio

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


async def test_new_message_defaults_to_an_unedited_chat(alice):
    session = await create_session(alice)
    created = (await post_message(alice, session["id"])).json()
    assert created["kind"] == "chat"
    assert created["edited"] is False
    assert created["editedAt"] is None

    listed = (await alice.get(f"/api/sessions/{session['id']}/messages")).json()[0]
    assert (listed["kind"], listed["edited"], listed["editedAt"]) == ("chat", False, None)


async def test_create_a_note(alice):
    session = await create_session(alice)
    resp = await post_message(alice, session["id"], kind="note", text="my own notes")
    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "note"
    assert body["role"] == "user"
    assert body["edited"] is False


async def test_a_note_cannot_be_authored_by_the_assistant(alice):
    session = await create_session(alice)
    resp = await post_message(alice, session["id"], kind="note", role="assistant")
    assert resp.status_code == 400
    assert "role 'user'" in resp.json()["detail"]


async def test_unknown_kind_is_422(alice):
    session = await create_session(alice)
    assert (await post_message(alice, session["id"], kind="scribble")).status_code == 422


async def test_notes_and_chats_share_one_timeline(alice):
    session = await create_session(alice)
    await post_message(alice, session["id"], text="question")
    await post_message(alice, session["id"], kind="note", text="my aside")
    await post_message(alice, session["id"], role="assistant", text="answer")

    listed = (await alice.get(f"/api/sessions/{session['id']}/messages")).json()
    assert [(m["kind"], m["text"]) for m in listed] == [
        ("chat", "question"),
        ("note", "my aside"),
        ("chat", "answer"),
    ]


async def test_edit_an_assistant_answer(alice):
    session = await create_session(alice)
    original = (await post_message(alice, session["id"], role="assistant", text="draft")).json()

    resp = await alice.patch(f"/api/messages/{original['id']}", json={"text": "my rewrite"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == "my rewrite"
    assert body["edited"] is True
    assert body["editedAt"] is not None
    assert body["role"] == "assistant"
    assert body["kind"] == "chat"


async def test_edit_persists(alice):
    session = await create_session(alice)
    msg = (await post_message(alice, session["id"], kind="note", text="first draft")).json()
    await alice.patch(f"/api/messages/{msg['id']}", json={"text": "second draft"})

    listed = (await alice.get(f"/api/sessions/{session['id']}/messages")).json()
    assert listed[0]["text"] == "second draft"
    assert listed[0]["edited"] is True
    assert listed[0]["kind"] == "note"


async def test_edit_cannot_change_role_or_kind(alice):
    session = await create_session(alice)
    msg = (await post_message(alice, session["id"], kind="note", text="mine")).json()

    resp = await alice.patch(
        f"/api/messages/{msg['id']}",
        json={"text": "still mine", "role": "assistant", "kind": "chat"},
    )
    assert resp.status_code == 200
    assert resp.json()["role"] == "user"
    assert resp.json()["kind"] == "note"


async def test_edit_to_empty_text_is_allowed(alice):
    session = await create_session(alice)
    msg = (await post_message(alice, session["id"], kind="note", text="typed then cleared")).json()
    resp = await alice.patch(f"/api/messages/{msg['id']}", json={"text": ""})
    assert resp.status_code == 200
    assert resp.json()["text"] == ""


async def test_edit_without_text_is_422(alice):
    session = await create_session(alice)
    msg = (await post_message(alice, session["id"])).json()
    assert (await alice.patch(f"/api/messages/{msg['id']}", json={})).status_code == 422


async def test_editing_a_missing_message_is_404(alice):
    assert (await alice.patch("/api/messages/nope", json={"text": "x"})).status_code == 404


async def test_edit_bumps_the_parent_session(alice):
    session = await create_session(alice)
    msg = (await post_message(alice, session["id"], text="hi")).json()
    before = (await alice.get("/api/sessions")).json()[0]["updatedAt"]

    await asyncio.sleep(0.01)
    await alice.patch(f"/api/messages/{msg['id']}", json={"text": "edited"})

    after = (await alice.get("/api/sessions")).json()[0]["updatedAt"]
    assert after > before


async def test_cannot_edit_another_users_message(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        session = await create_session(a)
        victim = (await post_message(a, session["id"], text="A's words")).json()

    async with auth_client(user_b) as b:
        resp = await b.patch(f"/api/messages/{victim['id']}", json={"text": "tampered"})
        assert resp.status_code == 404

    async with auth_client(user_a) as a:
        listed = (await a.get(f"/api/sessions/{session['id']}/messages")).json()
        assert listed[0]["text"] == "A's words"
        assert listed[0]["edited"] is False


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
