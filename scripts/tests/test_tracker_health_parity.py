"""Guards on the health stamp, which three runtimes read and none can see.

The tracker writes one settings row to say it is still working. The renderer
reads it to decide whether to raise the "Time has stopped recording" banner, and
the Rust host reads it to decide whether the process behind that banner is worth
replacing. Nothing links the three: a renamed key or a widened threshold
compiles, passes every other test, and fails only on a user's machine -- as
silence, which is the one symptom this whole signal exists to break.

Read the sources rather than running them, the way test_installer_hooks.py does:
the property worth protecting is a constant, and reproducing it needs a wedged
tracker on Windows.
"""

import re
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]


def read(*parts):
    return (REPOSITORY.joinpath(*parts)).read_text(encoding="utf-8")


TRACKER = read("tracker", "tracker.py")
RENDERER = read("dashboard", "src", "lib", "trackerHealth.ts")
HOST = read("dashboard", "src-tauri", "src", "lifecycle.rs")
QUERIES = read("dashboard", "src", "lib", "queries.ts")
DATABASE = read("dashboard", "src-tauri", "src", "database.rs")


def constant(source, pattern, label):
    match = re.search(pattern, source, re.M)
    assert match, f"{label} is not declared where this test looks for it"
    return match.group(1)


def test_the_host_replaces_a_tracker_no_later_than_the_banner_reports_one():
    """The banner's button calls into the host, so the host's patience cannot
    exceed the banner's. If it did, the reader would be shown an undismissable
    alarm whose button decided the tracker was still fine -- which is the defect
    this threshold was introduced to fix, restored by drift."""
    renderer = int(
        constant(
            RENDERER,
            r"^export const TRACKER_ALERT_STALE_SECONDS = (\d+);",
            "TRACKER_ALERT_STALE_SECONDS",
        )
    )
    host = int(
        constant(
            HOST,
            r"^const TRACKER_UNRESPONSIVE_SECONDS: i64 = (\d+);",
            "TRACKER_UNRESPONSIVE_SECONDS",
        )
    )
    assert host == renderer, (
        f"the host waits {host}s and the banner fires at {renderer}s;"
        " keep them equal or the banner's own button does nothing"
    )


def test_every_runtime_spells_the_health_key_the_same_way():
    """Three independent spellings of one settings row. A drift here is not an
    error anywhere: the reader simply gets no stamp, which reads as a tracker
    that has never run."""
    key = constant(
        TRACKER, r'^HEALTH_HEARTBEAT_KEY = "([a-z_]+)"', "HEALTH_HEARTBEAT_KEY"
    )
    assert f"key='{key}'" in QUERIES, f"the renderer query does not read {key}"
    assert f"key='{key}'" in DATABASE, f"the host query does not read {key}"


def test_the_stamp_is_written_far_more_often_than_either_reader_waits():
    """The thresholds above are only meaningful if a working tracker refreshes
    the stamp well inside them. Twenty-four intervals is the documented margin;
    this fails if the cadence is raised toward the alarm rather than the alarm
    away from the cadence."""
    cadence = int(
        constant(
            TRACKER,
            r"^HEALTH_HEARTBEAT_SECONDS = (\d+)",
            "HEALTH_HEARTBEAT_SECONDS",
        )
    )
    alert = int(
        constant(
            RENDERER,
            r"^export const TRACKER_ALERT_STALE_SECONDS = (\d+);",
            "TRACKER_ALERT_STALE_SECONDS",
        )
    )
    assert cadence * 4 <= alert, (
        f"a {cadence}s stamp against a {alert}s alarm leaves too little margin;"
        " one slow tick would report a working tracker as dead"
    )
