"""Compare the shared browser-title fixture against the extension repository.

Time and the Time Web Extension parse one marker grammar from
separate repositories, and each keeps its own copy of the conformance fixture.
Each copy is already checked against its own parser, so a check confined to one
repository proves only self-consistency: editing a fixture together with its own
expectations leaves both suites green while the two products disagree. Comparing
the copies is the only check that observes both sides at once.

The check skips when the extension is not on this machine. Time must stay
testable on its own, and the extension is the side with a release gate that
refuses rather than skips.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

DESKTOP_FIXTURE = (
    Path(__file__).parent / "fixtures" / "browser_title_protocol.json"
)
EXTENSION_FIXTURE_RELATIVE = Path("tests") / "fixtures" / "protocol.json"

# Set TIME_EXTENSION_REPO to check a checkout that is not beside this one.
_DEFAULT_SIBLINGS = ("Extension", "Time Web Extension", "time-browser-extension")


def _find_extension_fixture() -> Path | None:
    configured = os.environ.get("TIME_EXTENSION_REPO")
    repository_root = Path(__file__).resolve().parents[2]
    candidates = (
        [Path(configured)]
        if configured
        else [repository_root.parent / name for name in _DEFAULT_SIBLINGS]
    )
    for repository in candidates:
        fixture = repository / EXTENSION_FIXTURE_RELATIVE
        if fixture.is_file():
            return fixture
    return None


def test_shared_protocol_fixture_matches_the_extension_repository():
    extension_fixture = _find_extension_fixture()
    if extension_fixture is None:
        unverified = (
            "Time Web Extension checkout not found; protocol parity "
            "unverified. Set TIME_EXTENSION_REPO to check it."
        )
        # CI sets TIME_PARITY_REQUIRED because pytest exits 0 on a skip: a
        # mistyped checkout path would otherwise turn this gate green without
        # comparing anything, failing open exactly where it must fail closed.
        if os.environ.get("TIME_PARITY_REQUIRED"):
            pytest.fail(unverified)
        pytest.skip(unverified)

    assert DESKTOP_FIXTURE.read_text(encoding="utf-8") == extension_fixture.read_text(
        encoding="utf-8"
    ), (
        f"The shared protocol fixture differs from {extension_fixture}. Time and "
        "the extension must ship one identical fixture; update both."
    )
