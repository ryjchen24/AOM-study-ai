async def create_folder(c, **overrides):
    payload = {"name": "Physics", "color": "#4f46e5", "order": 0}
    payload.update(overrides)
    resp = await c.post("/api/folders", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_create_and_list(alice):
    created = await create_folder(alice, name="Physics")
    listed = (await alice.get("/api/folders")).json()
    assert [f["id"] for f in listed] == [created["id"]]
    assert listed[0]["name"] == "Physics"


async def test_list_is_ordered_by_order_field(alice):
    await create_folder(alice, name="third", order=3)
    await create_folder(alice, name="first", order=1)
    await create_folder(alice, name="second", order=2)
    names = [f["name"] for f in (await alice.get("/api/folders")).json()]
    assert names == ["first", "second", "third"]


async def test_nested_folder_records_parent(alice):
    parent = await create_folder(alice, name="School")
    child = await create_folder(alice, name="Physics", parentId=parent["id"])
    assert child["parentId"] == parent["id"]


async def test_update_renames(alice):
    folder = await create_folder(alice, name="Old")
    resp = await alice.patch(f"/api/folders/{folder['id']}", json={"name": "New"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "New"
    assert resp.json()["color"] == folder["color"]


async def test_empty_update_is_a_400(alice):
    folder = await create_folder(alice)
    resp = await alice.patch(f"/api/folders/{folder['id']}", json={})
    assert resp.status_code == 400


async def test_folder_cannot_be_its_own_parent(alice):
    folder = await create_folder(alice)
    resp = await alice.patch(
        f"/api/folders/{folder['id']}", json={"parentId": folder["id"]}
    )
    assert resp.status_code == 400
    assert "own parent" in resp.json()["error"]


async def test_delete_removes_it(alice):
    folder = await create_folder(alice)
    assert (await alice.delete(f"/api/folders/{folder['id']}")).status_code == 200
    assert (await alice.get("/api/folders")).json() == []


async def test_operations_on_a_missing_folder_are_404(alice):
    assert (await alice.patch("/api/folders/nope", json={"name": "x"})).status_code == 404
    assert (await alice.delete("/api/folders/nope")).status_code == 404


async def test_list_only_returns_your_own_folders(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        await create_folder(a, name="A's folder")
    async with auth_client(user_b) as b:
        await create_folder(b, name="B's folder")
        assert [f["name"] for f in (await b.get("/api/folders")).json()] == ["B's folder"]


async def test_cannot_read_or_mutate_another_users_folder(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        victim = await create_folder(a, name="A's folder")

    async with auth_client(user_b) as b:
        assert (await b.patch(f"/api/folders/{victim['id']}", json={"name": "hax"})).status_code == 404
        assert (await b.delete(f"/api/folders/{victim['id']}")).status_code == 404

    async with auth_client(user_a) as a:
        assert (await a.get("/api/folders")).json()[0]["name"] == "A's folder"


async def test_cannot_nest_under_another_users_folder(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        victim = await create_folder(a)

    async with auth_client(user_b) as b:
        resp = await b.post(
            "/api/folders",
            json={"name": "sneaky", "color": "#000", "parentId": victim["id"]},
        )
        assert resp.status_code == 404
