import json

import httpx
import pytest

import providers


@pytest.fixture
def capture(monkeypatch):
    recorded = {}

    def install(response_factory):
        def handler(request: httpx.Request) -> httpx.Response:
            recorded["request"] = request
            recorded["body"] = json.loads(request.content) if request.content else None
            return response_factory(request)

        monkeypatch.setattr(
            providers, "_make_client",
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        return recorded

    return install


def ok(text: str):
    return lambda request: httpx.Response(200, text=text)


async def collect(agen) -> list[str]:
    return [tok async for tok in agen]


KEY = "test-key-abcdef"
MESSAGES = [{"role": "user", "text": "hi"}]


async def test_anthropic_parses_text_deltas(capture):
    body = (
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"He"}}\n\n'
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}\n\n'
        'data: {"type":"message_stop"}\n\n'
    )
    capture(ok(body))
    assert await collect(providers.call_anthropic(KEY, "claude-sonnet-5", MESSAGES)) == ["He", "llo"]


async def test_anthropic_ignores_non_text_events(capture):
    body = (
        'data: {"type":"message_start","message":{}}\n\n'
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}\n\n'
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"real"}}\n\n'
    )
    capture(ok(body))
    assert await collect(providers.call_anthropic(KEY, "m", MESSAGES)) == ["real"]


async def test_openai_parses_choice_deltas_and_stops_on_done(capture):
    body = (
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
        "data: [DONE]\n\n"
    )
    capture(ok(body))
    assert await collect(providers.call_openai(KEY, "gpt-4o", MESSAGES)) == ["Hi", " there"]


async def test_mistral_uses_the_same_format_but_a_different_host(capture):
    recorded = capture(ok('data: {"choices":[{"delta":{"content":"bonjour"}}]}\n\n'))
    assert await collect(providers.call_mistral(KEY, "mistral-large", MESSAGES)) == ["bonjour"]
    assert str(recorded["request"].url).startswith("https://api.mistral.ai/")


async def test_google_joins_candidate_parts(capture):
    evt = {"candidates": [{"content": {"parts": [{"text": "a"}, {"text": "b"}]}}]}
    capture(ok(f"data: {json.dumps(evt)}\n\n"))
    assert await collect(providers.call_google(KEY, "gemini-2.0-flash", MESSAGES)) == ["ab"]


async def test_malformed_json_lines_are_skipped_not_fatal(capture):
    body = (
        "data: not-json\n\n"
        ": a comment line\n\n"
        'data: {"choices":[{"delta":{"content":"survived"}}]}\n\n'
    )
    capture(ok(body))
    assert await collect(providers.call_openai(KEY, "gpt-4o", MESSAGES)) == ["survived"]


async def test_the_system_prompt_is_sent(capture):
    recorded = capture(ok(""))
    await collect(providers.call_anthropic(KEY, "m", MESSAGES))
    assert recorded["body"]["system"] == providers.SYSTEM_PROMPT

    recorded = capture(ok(""))
    await collect(providers.call_openai(KEY, "m", MESSAGES))
    assert recorded["body"]["messages"][0] == {
        "role": "system",
        "content": providers.SYSTEM_PROMPT,
    }


async def test_text_attachments_are_inlined_into_the_prompt(capture):
    messages = [{
        "role": "user",
        "text": "summarize this",
        "attachments": [
            {"kind": "text", "name": "notes.txt", "data": "the mitochondria"}
        ],
    }]
    recorded = capture(ok(""))
    await collect(providers.call_anthropic(KEY, "m", messages))

    text_block = recorded["body"]["messages"][0]["content"][-1]["text"]
    assert "summarize this" in text_block
    assert "notes.txt" in text_block
    assert "the mitochondria" in text_block


async def test_image_attachments_use_each_providers_own_shape(capture):
    messages = [{
        "role": "user",
        "text": "what is this",
        "attachments": [{"kind": "image", "mime": "image/png", "data": "BASE64DATA"}],
    }]

    recorded = capture(ok(""))
    await collect(providers.call_anthropic(KEY, "m", messages))
    image = recorded["body"]["messages"][0]["content"][0]
    assert image["type"] == "image"
    assert image["source"]["data"] == "BASE64DATA"

    recorded = capture(ok(""))
    await collect(providers.call_openai(KEY, "m", messages))
    parts = recorded["body"]["messages"][1]["content"]
    assert parts[1]["image_url"]["url"] == "data:image/png;base64,BASE64DATA"

    recorded = capture(ok(""))
    await collect(providers.call_google(KEY, "m", messages))
    assert recorded["body"]["contents"][0]["parts"][0]["inline_data"]["data"] == "BASE64DATA"


async def test_mistral_drops_images_rather_than_sending_a_bad_request(capture):
    messages = [{
        "role": "user",
        "text": "hello",
        "attachments": [{"kind": "image", "mime": "image/png", "data": "BASE64DATA"}],
    }]
    recorded = capture(ok(""))
    await collect(providers.call_mistral(KEY, "m", messages))
    content = recorded["body"]["messages"][1]["content"]
    assert isinstance(content, str)
    assert "BASE64DATA" not in content


async def test_google_maps_assistant_to_the_model_role(capture):
    messages = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "hello"},
    ]
    recorded = capture(ok(""))
    await collect(providers.call_google(KEY, "m", messages))
    assert [c["role"] for c in recorded["body"]["contents"]] == ["user", "model"]


@pytest.mark.parametrize(
    "call,header",
    [
        (providers.call_anthropic, "x-api-key"),
        (providers.call_google, "x-goog-api-key"),
    ],
)
async def test_the_key_travels_in_a_header_never_the_url(capture, call, header):
    recorded = capture(ok(""))
    await collect(call(KEY, "some-model", MESSAGES))
    request = recorded["request"]
    assert request.headers[header] == KEY
    assert KEY not in str(request.url)


@pytest.mark.parametrize(
    "bad_model",
    ["../../etc/passwd", "model with spaces", "model?key=leak", "model/../other", ""],
)
async def test_unsafe_model_ids_are_rejected_before_any_request(capture, bad_model):
    recorded = capture(ok(""))
    with pytest.raises(providers.ProviderError) as exc:
        await collect(providers.call_google(KEY, bad_model, MESSAGES))
    assert exc.value.status_code == 400
    assert "request" not in recorded


async def test_a_missing_key_fails_fast(capture):
    capture(ok(""))
    with pytest.raises(providers.ProviderError) as exc:
        await collect(providers.call_openai("", "gpt-4o", MESSAGES))
    assert exc.value.status_code == 400


async def test_upstream_errors_are_redacted_of_the_key(capture):
    capture(lambda request: httpx.Response(401, text=f"bad key: {KEY}"))
    with pytest.raises(providers.ProviderError) as exc:
        await collect(providers.call_anthropic(KEY, "m", MESSAGES))
    assert KEY not in exc.value.message
    assert "***" in exc.value.message
    assert exc.value.status_code == 502


async def test_error_detail_is_truncated(capture):
    capture(lambda request: httpx.Response(500, text="x" * 5000))
    with pytest.raises(providers.ProviderError) as exc:
        await collect(providers.call_openai(KEY, "m", MESSAGES))
    assert len(exc.value.message) < 600


async def test_verify_key_accepts_a_200(capture):
    capture(lambda request: httpx.Response(200, json={"data": []}))
    assert await providers.verify_key("openai", KEY) == (True, None)


async def test_verify_key_reports_a_401_without_the_key(capture):
    capture(lambda request: httpx.Response(401, text=f"invalid: {KEY}"))
    ok_, error = await providers.verify_key("anthropic", KEY)
    assert ok_ is False
    assert KEY not in error
    assert "401" in error


async def test_verify_key_rejects_an_unknown_provider():
    with pytest.raises(providers.ProviderError):
        await providers.verify_key("ollama", KEY)


@pytest.mark.parametrize("provider", sorted(providers.PROVIDERS))
async def test_every_registered_provider_has_a_verify_url(provider):
    assert provider in providers._VERIFY_URLS
