"""Guards the one mirrored contract in AGENTS.md that nothing else enforces.

Validation ranges live in two places: the clamps in `get_settings`
(tracker/db.py), which decide what the tracker actually runs with, and `SPECS`
(dashboard/src/tabs/SettingsTab.tsx), which decides what the reader is allowed
to type. Neither can observe the other.

The failure is silent in the worst way, because the reader is looking straight
at it. Widen a `SPECS` maximum past its clamp and Settings accepts the value,
saves it, reads it back, and displays it — while the tracker quietly runs on the
clamped one. Nothing is broken, nothing is logged, and the number on screen is a
lie for as long as it is left there.

Read both files as source. The alternative is exporting `SPECS` from a component
module purely to be imported by a test, which changes shipping code to suit the
guard rather than the other way round.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
PYTHON = (REPOSITORY / "tracker" / "db.py").read_text(encoding="utf-8")
SETTINGS_TAB = (
    REPOSITORY / "dashboard" / "src" / "tabs" / "SettingsTab.tsx"
).read_text(encoding="utf-8")

# `_float("key", default, lo, hi)` — the tracker's clamp for one setting.
CLAMP = re.compile(
    r'_float\(\s*"(?P<key>[a-z_]+)"\s*,\s*(?P<default>[\d.]+)\s*,'
    r'\s*(?P<lo>[\d.]+)\s*,\s*(?P<hi>[\d.]+)\s*\)'
)

# One `SPECS` entry. `scale` converts the displayed unit to the stored one —
# minutes to seconds, mostly — so the comparable range is min*scale..max*scale.
SPEC = re.compile(
    r'\{\s*key:\s*"(?P<key>[a-z_]+)"\s*,\s*min:\s*(?P<min>[\d.]+)\s*,'
    r'\s*max:\s*(?P<max>[\d.]+)\s*,\s*scale:\s*(?P<scale>[\d.]+)'
)

# `"key": "value",` in DEFAULT_SETTINGS, for the third copy of each default.
def seeded_default(key):
    match = re.search(rf'"{key}":\s*"([^"]*)"', PYTHON)
    return match.group(1) if match else None


def clamps():
    found = {
        match.group("key"): (
            float(match.group("default")),
            float(match.group("lo")),
            float(match.group("hi")),
        )
        for match in CLAMP.finditer(PYTHON)
    }
    assert found, "no _float clamps found in tracker/db.py; the regex has rotted"
    return found


def specs():
    found = {
        match.group("key"): (
            float(match.group("min")) * float(match.group("scale")),
            float(match.group("max")) * float(match.group("scale")),
        )
        for match in SPEC.finditer(SETTINGS_TAB)
    }
    assert found, "no SPECS entries found in SettingsTab.tsx; the regex has rotted"
    return found


def test_the_two_sides_still_share_at_least_one_setting():
    """If this fails the guard below is vacuously true, which is worse than a
    missing guard because it reads like coverage."""
    shared = set(clamps()) & set(specs())
    assert shared, (
        "no setting is both clamped by the tracker and offered by Settings;"
        " one side was renamed and the comparison below stopped comparing"
    )


def test_settings_never_offers_a_value_the_tracker_would_clamp():
    """Equality is not required — a narrower UI is safe and is the current state
    for the idle threshold, whose UI works in whole minutes and so cannot reach
    the tracker's 30-second floor. What must never happen is the reverse."""
    tracker = clamps()
    ui = specs()
    for key in sorted(set(tracker) & set(ui)):
        _, lo, hi = tracker[key]
        low, high = ui[key]
        assert low >= lo, (
            f"{key}: Settings offers a minimum of {low}, below the tracker's"
            f" clamp of {lo}. The reader would see their own value and the"
            f" tracker would run on {lo}."
        )
        assert high <= hi, (
            f"{key}: Settings offers a maximum of {high}, above the tracker's"
            f" clamp of {hi}. The reader would see their own value and the"
            f" tracker would run on {hi}."
        )


def test_the_clamp_fallback_agrees_with_the_seeded_default():
    """A third copy of each default, and the least visible of them. `_float`'s
    fallback applies when the key is absent — which is what an older database
    looks like after a setting is added — so a disagreement here means a
    database that predates the setting behaves differently from a fresh one,
    with both reporting the same thing in Settings."""
    for key, (default, _, _) in sorted(clamps().items()):
        seeded = seeded_default(key)
        if seeded is None:
            continue
        assert float(seeded) == default, (
            f"{key}: DEFAULT_SETTINGS seeds {seeded} but the get_settings"
            f" fallback is {default}; a database missing this key would run"
            f" on a different value than a fresh install"
        )
