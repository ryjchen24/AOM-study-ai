import os

import pytest

import main


@pytest.fixture
def dist(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<!doctype html><title>AMO</title>")
    (tmp_path / "app.jsx").write_text("// built app")
    monkeypatch.setattr(main, "FRONTEND_DIST", str(tmp_path))
    return tmp_path


async def test_root_serves_the_shell(client, dist):
    resp = await client.get("/")
    assert resp.status_code == 200
    assert "AMO" in resp.text


async def test_real_files_are_served_from_disk(client, dist):
    resp = await client.get("/app.jsx")
    assert resp.status_code == 200
    assert resp.text == "// built app"


@pytest.mark.parametrize("path", ["/files", "/chat/some-session-id", "/deep/link"])
async def test_client_routes_fall_back_to_index(client, dist, path):
    resp = await client.get(path)
    assert resp.status_code == 200
    assert "AMO" in resp.text


async def test_unknown_api_paths_are_json_404s(client, dist):
    for path in ("/api", "/api/nope", "/api/sessions/x/y/z"):
        resp = await client.get(path)
        assert resp.status_code == 404, path
        assert resp.json() == {"error": "Not found."}


@pytest.mark.parametrize(
    "path",
    ["/../main.py", "/../../etc/passwd", "/subdir/../../security.py"],
)
async def test_path_traversal_cannot_escape_the_dist_directory(client, dist, path):
    resp = await client.get(path)
    assert "KEY_ENCRYPTION_KEY" not in resp.text
    assert "SESSION_SECRET" not in resp.text


async def test_traversal_target_outside_dist_is_not_served(client, dist, tmp_path):
    secret = tmp_path.parent / "outside.txt"
    secret.write_text("TOP SECRET")
    resp = await client.get(f"/../{secret.name}")
    assert "TOP SECRET" not in resp.text


async def test_missing_build_gives_a_clear_503(client, monkeypatch, tmp_path):
    monkeypatch.setattr(main, "FRONTEND_DIST", str(tmp_path / "does-not-exist"))
    resp = await client.get("/")
    assert resp.status_code == 503
    assert "npm run build" in resp.json()["error"]


def test_frontend_dist_points_at_the_real_build_directory():
    assert os.path.basename(main.FRONTEND_DIST) == "dist"
    assert os.path.basename(os.path.dirname(main.FRONTEND_DIST)) == "frontend"
