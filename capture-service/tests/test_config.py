"""Configuration: every variable is read, validated and documented.

Config is the part of this service an IT admin actually touches (the install
script in docs/local-capture-plan.md generates a .env), so a typo has to fail at
start-up with the variable's name in the message — not three requests into a
meeting, with an opaque decoder error.
"""

from __future__ import annotations

import dataclasses

import pytest

from capture_service.config import (
    DEFAULTS,
    DEFAULT_MAX_UPLOAD_BYTES,
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_OLLAMA_MODEL,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_WHISPER_MODEL,
    ENV_VAR_NAMES,
    WHISPER_COMPUTE_TYPES,
    WHISPER_DEVICES,
    Settings,
    load_settings,
)
from capture_service.errors import ConfigError

# name -> (value to set, Settings attribute it must land in, expected result)
ENV_EFFECT: dict[str, tuple[str, str, object]] = {
    "CAPTURE_WHISPER_MODEL": ("small.en", "whisper_model", "small.en"),
    "CAPTURE_WHISPER_DEVICE": ("cuda", "whisper_device", "cuda"),
    "CAPTURE_WHISPER_COMPUTE_TYPE": ("float16", "whisper_compute_type", "float16"),
    "CAPTURE_WHISPER_LANGUAGE": ("en", "whisper_language", "en"),
    "CAPTURE_OLLAMA_BASE_URL": (
        "http://ollama.lan:11434/",
        "ollama_base_url",
        "http://ollama.lan:11434",
    ),
    "CAPTURE_OLLAMA_MODEL": ("qwen2.5:7b-instruct", "ollama_model", "qwen2.5:7b-instruct"),
    "CAPTURE_TIMEOUT_SECONDS": ("45", "timeout_seconds", 45.0),
    "CAPTURE_MAX_UPLOAD_BYTES": ("1048576", "max_upload_bytes", 1048576),
    "CAPTURE_HOST": ("0.0.0.0", "host", "0.0.0.0"),
    "CAPTURE_PORT": ("9000", "port", 9000),
    # A valid secret lands verbatim; the empty/unset case (auth off) and the
    # too-short case are covered by their own tests below.
    "CAPTURE_SHARED_SECRET": (
        "a" * 32,
        "shared_secret",
        "a" * 32,
    ),
    "CAPTURE_ALLOWED_ORIGINS": (
        "https://review.example.com,https://localhost",
        "allowed_origins",
        ["https://review.example.com", "https://localhost"],
    ),
}


def test_defaults_are_the_documented_local_install_values() -> None:
    settings = load_settings({})
    assert settings == Settings(
        whisper_model="base.en",
        whisper_device="cpu",
        whisper_compute_type="int8",
        whisper_language=None,
        ollama_base_url="http://127.0.0.1:11434",
        ollama_model="qwen2.5:7b",
        timeout_seconds=600.0,
        max_upload_bytes=200 * 1024 * 1024,
        host="127.0.0.1",
        port=8080,
        shared_secret=None,
        allowed_origins=None,
    )


def test_default_constants_agree_with_the_defaults_map() -> None:
    assert DEFAULT_WHISPER_MODEL == DEFAULTS["CAPTURE_WHISPER_MODEL"]
    assert DEFAULT_OLLAMA_BASE_URL == DEFAULTS["CAPTURE_OLLAMA_BASE_URL"]
    assert DEFAULT_OLLAMA_MODEL == DEFAULTS["CAPTURE_OLLAMA_MODEL"]
    assert DEFAULT_TIMEOUT_SECONDS == float(DEFAULTS["CAPTURE_TIMEOUT_SECONDS"])
    assert DEFAULT_MAX_UPLOAD_BYTES == int(DEFAULTS["CAPTURE_MAX_UPLOAD_BYTES"])
    assert DEFAULT_PORT == int(DEFAULTS["CAPTURE_PORT"])


def test_every_documented_variable_is_listened_to() -> None:
    """No variable may be documented-but-unread, or read-but-undocumented."""
    assert set(ENV_VAR_NAMES) == set(DEFAULTS)
    assert set(ENV_EFFECT) == set(DEFAULTS)


def test_every_variable_lands_in_a_settings_field() -> None:
    field_names = {f.name for f in dataclasses.fields(Settings)}
    assert {attr for _, attr, _ in ENV_EFFECT.values()} <= field_names


@pytest.mark.parametrize("name", sorted(ENV_EFFECT))
def test_variable_is_read_from_the_environment(name: str) -> None:
    value, attr, expected = ENV_EFFECT[name]
    assert getattr(load_settings({name: value}), attr) == expected


@pytest.mark.parametrize("name", sorted(ENV_EFFECT))
def test_unrelated_variables_do_not_disturb_the_others(name: str) -> None:
    value, attr, expected = ENV_EFFECT[name]
    baseline = load_settings({})
    settings = load_settings({name: value})
    for other in dataclasses.fields(Settings):
        if other.name == attr:
            continue
        assert getattr(settings, other.name) == getattr(baseline, other.name)


def test_settings_are_read_from_os_environ_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPTURE_OLLAMA_MODEL", "llama3.1:8b-instruct")
    monkeypatch.setenv("CAPTURE_MAX_UPLOAD_BYTES", "2048")
    assert load_settings().ollama_model == "llama3.1:8b-instruct"
    assert load_settings().max_upload_bytes == 2048


def test_values_are_whitespace_trimmed() -> None:
    settings = load_settings(
        {"CAPTURE_OLLAMA_MODEL": "  deepseek-r1:7b  ", "CAPTURE_WHISPER_MODEL": "\tsmall\n"}
    )
    assert settings.ollama_model == "deepseek-r1:7b"
    assert settings.whisper_model == "small"


def test_settings_are_immutable() -> None:
    settings = load_settings({})
    with pytest.raises(dataclasses.FrozenInstanceError):
        settings.ollama_model = "something-else"  # type: ignore[misc]


# ─── Empty / missing values ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    [
        "CAPTURE_WHISPER_MODEL",
        "CAPTURE_OLLAMA_MODEL",
        "CAPTURE_HOST",
        "CAPTURE_OLLAMA_BASE_URL",
    ],
)
def test_empty_value_is_rejected_rather_than_silently_defaulted(name: str) -> None:
    # `FOO=` in a generated .env is a common install-script bug. Falling back to
    # the default would hide it; failing names it.
    with pytest.raises(ConfigError) as error:
        load_settings({name: ""})
    assert name in str(error.value)


def test_empty_language_means_auto_detect() -> None:
    # The one variable where blank is a setting, not a mistake.
    assert load_settings({"CAPTURE_WHISPER_LANGUAGE": ""}).whisper_language is None
    assert load_settings({"CAPTURE_WHISPER_LANGUAGE": "   "}).whisper_language is None
    assert load_settings({"CAPTURE_WHISPER_LANGUAGE": "de"}).whisper_language == "de"


# ─── Ollama base URL ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("http://127.0.0.1:11434", "http://127.0.0.1:11434"),
        ("http://127.0.0.1:11434/", "http://127.0.0.1:11434"),
        ("https://ollama.internal:443", "https://ollama.internal:443"),
        ("http://ollama.internal", "http://ollama.internal"),
        ("  http://ollama.internal:11434  ", "http://ollama.internal:11434"),
    ],
)
def test_base_url_is_normalised_to_a_root(given: str, expected: str) -> None:
    assert load_settings({"CAPTURE_OLLAMA_BASE_URL": given}).ollama_base_url == expected


@pytest.mark.parametrize(
    "given",
    [
        "ollama.internal:11434",  # no scheme
        "127.0.0.1",  # no scheme
        "ftp://ollama.internal",  # wrong scheme
        "file:///etc/passwd",  # wrong scheme
        "http://ollama.internal/api",  # a path: /api/chat would be appended to it
        "http://ollama.internal/v1/",  # an OpenAI-style prefix
        "://nope",
    ],
)
def test_base_url_that_would_send_the_request_somewhere_else_is_rejected(
    given: str,
) -> None:
    with pytest.raises(ConfigError) as error:
        load_settings({"CAPTURE_OLLAMA_BASE_URL": given})
    assert "CAPTURE_OLLAMA_BASE_URL" in str(error.value)


def test_base_url_may_not_carry_a_credential() -> None:
    # A password in a URL ends up in every log line and process listing that
    # prints it. Ollama has no auth, so there is nothing legitimate here.
    with pytest.raises(ConfigError) as error:
        load_settings({"CAPTURE_OLLAMA_BASE_URL": "http://user:hunter2@ollama.internal"})
    message = str(error.value)
    assert "CAPTURE_OLLAMA_BASE_URL" in message
    assert "hunter2" not in message


# ─── Allowlists ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("device", WHISPER_DEVICES)
def test_every_whisper_device_is_accepted(device: str) -> None:
    assert load_settings({"CAPTURE_WHISPER_DEVICE": device}).whisper_device == device


@pytest.mark.parametrize("compute_type", WHISPER_COMPUTE_TYPES)
def test_every_whisper_compute_type_is_accepted(compute_type: str) -> None:
    settings = load_settings({"CAPTURE_WHISPER_COMPUTE_TYPE": compute_type})
    assert settings.whisper_compute_type == compute_type


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("CAPTURE_WHISPER_DEVICE", "gpu"),
        ("CAPTURE_WHISPER_DEVICE", "CPU"),
        ("CAPTURE_WHISPER_COMPUTE_TYPE", "int4"),
        ("CAPTURE_WHISPER_COMPUTE_TYPE", "fp16"),
    ],
)
def test_unknown_allowlist_value_is_rejected_with_the_choices_listed(
    name: str, value: str
) -> None:
    with pytest.raises(ConfigError) as error:
        load_settings({name: value})
    message = str(error.value)
    assert name in message
    assert value in message
    # The fix has to be in the message, not in the docs the admin has not read.
    assert "cpu" in message or "int8" in message


def test_a_custom_whisper_model_path_is_allowed() -> None:
    # The allowlists cover device and compute type, but not the model: an org
    # with a fine-tuned or air-gapped model points at a directory on disk.
    settings = load_settings({"CAPTURE_WHISPER_MODEL": "/opt/models/distil-large-v3"})
    assert settings.whisper_model == "/opt/models/distil-large-v3"


# ─── Numbers ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("CAPTURE_MAX_UPLOAD_BYTES", "200MB"),
        ("CAPTURE_MAX_UPLOAD_BYTES", "1.5"),
        ("CAPTURE_MAX_UPLOAD_BYTES", "not-a-number"),
        ("CAPTURE_MAX_UPLOAD_BYTES", "0"),
        ("CAPTURE_MAX_UPLOAD_BYTES", "-1"),
        ("CAPTURE_PORT", "0"),
        ("CAPTURE_PORT", "70000"),
        ("CAPTURE_PORT", "eighty"),
        ("CAPTURE_TIMEOUT_SECONDS", "0"),
        ("CAPTURE_TIMEOUT_SECONDS", "-30"),
        ("CAPTURE_TIMEOUT_SECONDS", "soon"),
        ("CAPTURE_TIMEOUT_SECONDS", "nan"),
        ("CAPTURE_TIMEOUT_SECONDS", "inf"),
    ],
)
def test_bad_numbers_are_rejected(name: str, value: str) -> None:
    with pytest.raises(ConfigError) as error:
        load_settings({name: value})
    assert name in str(error.value)


def test_nan_and_infinite_timeouts_are_rejected() -> None:
    # float() happily parses both. A NaN timeout times out instantly; an
    # infinite one hangs the worker for the rest of the process's life.
    for value in ("nan", "NaN", "inf", "-inf", "infinity"):
        with pytest.raises(ConfigError):
            load_settings({"CAPTURE_TIMEOUT_SECONDS": value})


@pytest.mark.parametrize("value", ["1", "45.5", "600"])
def test_fractional_timeouts_are_allowed(value: str) -> None:
    assert load_settings({"CAPTURE_TIMEOUT_SECONDS": value}).timeout_seconds == float(value)


def test_a_small_upload_limit_is_allowed() -> None:
    # An operator tightening the ceiling is a policy choice, not a typo, so it
    # is validated as "positive" and no higher.
    assert load_settings({"CAPTURE_MAX_UPLOAD_BYTES": "1"}).max_upload_bytes == 1
