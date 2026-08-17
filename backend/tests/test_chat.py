import json

import httpx
import pytest

import main
import providers
from test_keys import ANTHROPIC_KEY, OPENAI_KEY, add_key


def anthropic_stream(*tokens: str) -> str:
    lines = []
    for tok in tokens:
        evt = {
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": tok},
        }
        lines.append(f"data: {json.dumps(evt)}\n\n")
    lines.append('data: {"type": "message_stop"}\n\n')
    return "".join(lines)


@pytest.fixture
def mock_upstream(monkeypatch):
    recorded = {}

    def install(handler):
        def wrapped(request: httpx.Request) -> httpx.Response:
            recorded["request"] = request
            return handler(request)

        monkeypatch.setattr(
            providers, "_make_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(wrapped)),
        )
        return recorded

    return install


def sse_events(text: str) -> list[dict]:
    return [
        json.loads(line[len("data: "):])
        for line in text.splitlines()
        if line.startswith("data: ")
    ]


async def chat(c, **overrides):
    payload = {
        "provider": "anthropic",
        "model": "claude-sonnet-5",
        "messages": [{"role": "user", "text": "what is entropy?"}],
    }
    payload.update(overrides)
    return await c.post("/api/chat", json=payload)


async def test_streams_tokens_then_done(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    mock_upstream(lambda req: httpx.Response(200, text=anthropic_stream("Ent", "ropy")))

    resp = await chat(alice)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = sse_events(resp.text)
    assert [e["text"] for e in events if e["type"] == "token"] == ["Ent", "ropy"]
    assert events[-1] == {"type": "done"}


async def test_uses_the_callers_own_stored_key(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    recorded = mock_upstream(lambda req: httpx.Response(200, text=anthropic_stream("hi")))

    await chat(alice)
    request = recorded["request"]
    assert request.headers["x-api-key"] == ANTHROPIC_KEY
    assert str(request.url).startswith("https://api.anthropic.com/")


async def test_picks_the_key_matching_the_requested_provider(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    await add_key(alice, provider="openai", key=OPENAI_KEY)
    recorded = mock_upstream(lambda req: httpx.Response(200, text='data: [DONE]\n\n'))

    await chat(alice, provider="openai", model="gpt-4o")
    assert recorded["request"].headers["authorization"] == f"Bearer {OPENAI_KEY}"


async def test_no_key_for_provider_is_a_clean_400(alice):
    resp = await chat(alice)
    assert resp.status_code == 400
    assert resp.json() == {"error": "no_key_for_provider"}


async def test_another_users_key_is_not_borrowed(auth_client, make_user):
    user_a, user_b = await make_user(), await make_user()
    async with auth_client(user_a) as a:
        await add_key(a, provider="anthropic", key=ANTHROPIC_KEY)

    async with auth_client(user_b) as b:
        assert (await chat(b)).json() == {"error": "no_key_for_provider"}


async def test_empty_message_list_is_rejected(alice):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    resp = await chat(alice, messages=[])
    assert resp.status_code == 400
    assert "non-empty" in resp.json()["error"]


async def test_unknown_provider_is_422(alice):
    assert (await chat(alice, provider="ollama")).status_code == 422


async def test_upstream_failure_becomes_an_sse_error_event(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    mock_upstream(lambda req: httpx.Response(500, text="upstream exploded"))

    resp = await chat(alice)
    assert resp.status_code == 200
    events = sse_events(resp.text)
    assert events[-1]["type"] == "error"
    assert "500" in events[-1]["message"]


async def test_upstream_error_body_is_stripped_of_the_key(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    mock_upstream(
        lambda req: httpx.Response(401, text=f"invalid key {ANTHROPIC_KEY}")
    )

    resp = await chat(alice)
    assert ANTHROPIC_KEY not in resp.text
    assert "***" in sse_events(resp.text)[-1]["message"]


async def test_a_malformed_model_id_never_reaches_the_network(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    recorded = mock_upstream(lambda req: httpx.Response(200, text=anthropic_stream("x")))

    resp = await chat(alice, model="../../evil")
    assert sse_events(resp.text)[-1]["type"] == "error"
    assert "request" not in recorded


def test_no_notes_leaves_the_system_prompt_alone():
    assert main.build_system_prompt([]) == providers.SYSTEM_PROMPT
    assert main.build_system_prompt(["", "   ", "\n"]) == providers.SYSTEM_PROMPT


def test_notes_are_folded_into_the_system_prompt():
    system = main.build_system_prompt(["focus on lecture 3", "prefer short answers"])
    assert system.startswith(providers.SYSTEM_PROMPT)
    assert "focus on lecture 3" in system
    assert "prefer short answers" in system
    assert "<notes>" in system and "</notes>" in system


def test_notes_keep_chronological_order():
    system = main.build_system_prompt(["first", "second", "third"])
    assert system.index("first") < system.index("second") < system.index("third")


def test_oldest_notes_are_dropped_when_over_budget():
    old = "O" * (main.MAX_NOTE_CHARS - 10)
    recent = "R" * 50
    system = main.build_system_prompt([old, recent])
    assert recent in system
    assert old not in system


def test_a_single_oversized_note_is_truncated_not_dropped():
    huge = "H" * (main.MAX_NOTE_CHARS * 3)
    system = main.build_system_prompt([huge])
    assert "H" in system
    assert len(system) < len(providers.SYSTEM_PROMPT) + main.MAX_NOTE_CHARS + 600


async def test_notes_reach_the_provider_as_system_context(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    recorded = mock_upstream(lambda req: httpx.Response(200, text=anthropic_stream("ok")))

    await chat(alice, notes=["focus on lecture 3"])

    body = json.loads(recorded["request"].content)
    assert "focus on lecture 3" in body["system"]
    # Notes must NOT become conversation turns — that's what would break
    # Anthropic's strict user/assistant alternation.
    assert all("focus on lecture 3" not in json.dumps(m) for m in body["messages"])


async def test_notes_reach_openai_as_a_system_message(alice, mock_upstream):
    await add_key(alice, provider="openai", key=OPENAI_KEY)
    recorded = mock_upstream(lambda req: httpx.Response(200, text="data: [DONE]\n\n"))

    await chat(alice, provider="openai", model="gpt-4o", notes=["cite sources"])

    body = json.loads(recorded["request"].content)
    assert body["messages"][0]["role"] == "system"
    assert "cite sources" in body["messages"][0]["content"]


async def test_omitting_notes_is_valid_and_sends_the_plain_prompt(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    recorded = mock_upstream(lambda req: httpx.Response(200, text=anthropic_stream("ok")))

    # Older clients don't send the field at all.
    resp = await alice.post("/api/chat", json={
        "provider": "anthropic",
        "model": "claude-sonnet-5",
        "messages": [{"role": "user", "text": "hi"}],
    })
    assert resp.status_code == 200
    assert json.loads(recorded["request"].content)["system"] == providers.SYSTEM_PROMPT


async def test_notes_must_be_strings(alice):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    assert (await chat(alice, notes=[{"text": "nope"}])).status_code == 422


async def test_streaming_headers_disable_buffering(alice, mock_upstream):
    await add_key(alice, provider="anthropic", key=ANTHROPIC_KEY)
    mock_upstream(lambda req: httpx.Response(200, text=anthropic_stream("hi")))

    resp = await chat(alice)
    assert resp.headers["cache-control"] == "no-cache, no-transform"
    assert resp.headers["x-accel-buffering"] == "no"
