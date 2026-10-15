"""Configuration: the documented defaults, and a named error for anything else.

The shape of this file follows capture-service/tests/test_config.py, because the
failure it exists to prevent is the same one: an installer writes a plausible
value into `.env`, the service starts, and the mistake surfaces as an opaque
failure on the first request instead of a sentence naming the variable.
"""

from __future__ import annotations

import pytest

from convert_service.config import (
    DEFAULTS,
    DEFAULT_CONCURRENCY,
    DEFAULT_GLTFPACK,
    DEFAULT_HOST,
    DEFAULT_MAX_UPLOAD_BYTES,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_SECONDS,
    ENV_VAR_NAMES,
    MIN_SHARED_SECRET_LENGTH,
    Settings,
    load_settings,
)
from convert_service.errors import ConfigError

# Every variable, with a value that differs from the default and the Settings
# field it must land in. Walking this is what stops a variable being added to
# Settings but never read (or read but never documented).
VARIABLE_ROUNDS_TRIP: dict[str, tuple[str, str, object]] = {
    "CONVERT_MAX_UPLOAD_BYTES": ("1048576", "max_upload_bytes", 1048576),
    "CONVERT_TIMEOUT_S": ("45", "timeout_seconds", 45.0),
    "CONVERT_CONCURRENCY": ("3", "concurrency", 3),
    "CONVERT_GLTFPACK": ("/opt/bin/gltfpack", "gltfpack", "/opt/bin/gltfpack"),
    "CONVERT_HOST": ("0.0.0.0", "host", "0.0.0.0"),
    "CONVERT_PORT": ("9001", "port", 9001),
    "CONVERT_SHARED_SECRET": ("a" * 32, "shared_secret", "a" * 32),
}


def test_documented_defaults_are_the_real_defaults():
    settings = load_settings({})

    assert settings.max_upload_bytes == 200 * 1024 * 1024
    assert settings.max_upload_bytes == DEFAULT_MAX_UPLOAD_BYTES
    assert settings.timeout_seconds == 900.0 == DEFAULT_TIMEOUT_SECONDS
    assert settings.concurrency == 1 == DEFAULT_CONCURRENCY
    assert settings.gltfpack == "gltfpack" == DEFAULT_GLTFPACK
    assert settings.host == "127.0.0.1" == DEFAULT_HOST
    assert settings.port == 8080 == DEFAULT_PORT
    # No secret by default: empty means authentication is off, which is only safe
    # because the default bind address is the loopback interface.
    assert settings.shared_secret is None


def test_every_documented_variable_has_a_default_and_reaches_settings():
    assert set(ENV_VAR_NAMES) == set(DEFAULTS)

    for name, (value, attribute, expected) in VARIABLE_ROUNDS_TRIP.items():
        assert name in ENV_VAR_NAMES, f"{name} is read but not documented"
        settings = load_settings({name: value})
        assert getattr(settings, attribute) == expected, f"{name} did not reach {attribute}"


def test_the_process_environment_is_the_default_source(monkeypatch):
    monkeypatch.setenv("CONVERT_MAX_UPLOAD_BYTES", "2048")
    monkeypatch.setenv("CONVERT_CONCURRENCY", "2")

    settings = load_settings()

    assert settings.max_upload_bytes == 2048
    assert settings.concurrency == 2


def test_values_are_stripped_before_they_are_validated():
    # A secret pasted into a compose file or a curl command line picks up a
    # trailing newline often enough that rejecting it would cost somebody an
    # hour. auth.py strips the presented side the same way, so the two agree.
    settings = load_settings({"CONVERT_SHARED_SECRET": f"  {'b' * 32}\n"})

    assert settings.shared_secret == "b" * 32


def test_an_unset_variable_and_an_empty_one_are_the_same_thing():
    assert load_settings({"CONVERT_GLTFPACK": "   "}).gltfpack == DEFAULT_GLTFPACK


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("CONVERT_MAX_UPLOAD_BYTES", "200MB"),
        ("CONVERT_MAX_UPLOAD_BYTES", "1.5"),
        ("CONVERT_MAX_UPLOAD_BYTES", "not-a-number"),
        ("CONVERT_MAX_UPLOAD_BYTES", "0"),
        ("CONVERT_MAX_UPLOAD_BYTES", "-1"),
        ("CONVERT_TIMEOUT_S", "soon"),
        ("CONVERT_TIMEOUT_S", "0"),
        ("CONVERT_TIMEOUT_S", "-30"),
        # float() accepts both, and either would make every conversion time out
        # immediately or hang for ever.
        ("CONVERT_TIMEOUT_S", "nan"),
        ("CONVERT_TIMEOUT_S", "inf"),
        ("CONVERT_CONCURRENCY", "lots"),
        ("CONVERT_CONCURRENCY", "0"),
        ("CONVERT_PORT", "70000"),
        ("CONVERT_PORT", "http"),
    ],
)
def test_an_unusable_value_names_the_variable(name, value):
    with pytest.raises(ConfigError) as failure:
        load_settings({name: value})

    assert name in failure.value.message
    assert failure.value.code == "config_invalid"


def test_a_secret_that_is_too_short_is_refused_without_being_quoted():
    short = "changeme"

    with pytest.raises(ConfigError) as failure:
        load_settings({"CONVERT_SHARED_SECRET": short})

    message = failure.value.message
    assert "CONVERT_SHARED_SECRET" in message
    assert str(MIN_SHARED_SECRET_LENGTH) in message
    # The one validator that must not show the value it was given: this message is
    # printed to stderr by `python -m convert_service`, captured by docker logs
    # and pasted into issue trackers. The LENGTH is reported instead.
    assert short not in message
    assert str(len(short)) in message


def test_a_long_enough_secret_is_accepted_verbatim():
    secret = "0" * MIN_SHARED_SECRET_LENGTH

    assert load_settings({"CONVERT_SHARED_SECRET": secret}).shared_secret == secret


def test_settings_are_immutable():
    settings = load_settings({})

    with pytest.raises(Exception):
        settings.port = 1  # type: ignore[misc]


def test_settings_defaults_are_a_valid_construction():
    # A Settings built by hand (as the tests do) has to agree with the loaded one.
    assert Settings(
        max_upload_bytes=DEFAULT_MAX_UPLOAD_BYTES,
        timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
        concurrency=DEFAULT_CONCURRENCY,
        gltfpack=DEFAULT_GLTFPACK,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
    ) == load_settings({})
