import logging

from tracker import config, db, tracker


class FakeController:
    """Records what the tray was told, without a native icon behind it."""

    def __init__(self):
        self.enabled = []
        self.states = []

    def set_enabled(self, enabled):
        self.enabled.append(enabled)
        return enabled

    def sync_state(self, paused, until, recording_schedule):
        self.states.append(
            (paused, until, recording_schedule.recording_allowed, recording_schedule.next_start)
        )


def _forbid_background_components(monkeypatch) -> None:
    def unexpected(*_args, **_kwargs):
        raise AssertionError("maintenance startup launched a background component")

    monkeypatch.setattr(
        tracker.media_playback,
        "start_media_playback_monitor",
        unexpected,
    )
    monkeypatch.setattr(
        tracker.power_events,
        "start_power_event_monitor",
        unexpected,
    )
    monkeypatch.setattr(tracker.tray, "create_tray_controller", unexpected)


def test_tray_sync_keeps_visibility_separate_from_pause_state():
    controller = FakeController()
    visible = tracker._sync_tray(
        controller,
        {
            "show_tray_icon": "0",
            "tracking_paused": "0",
            "tracking_paused_until": "2000",
        },
        now=1_000,
    )

    assert visible is False
    assert controller.enabled == [False]
    assert controller.states == [(True, 2_000, True, None)]
    assert tracker._sync_tray(None, {}, now=1_000) is False


def test_tray_sync_reports_an_expired_timed_pause_as_recording():
    """The boundary is evaluated at `now`; a stale one must not read as paused."""
    controller = FakeController()

    visible = tracker._sync_tray(
        controller,
        {
            "show_tray_icon": "1",
            "tracking_paused": "0",
            "tracking_paused_until": "500",
        },
        now=1_000,
    )

    assert visible is True
    assert controller.enabled == [True]
    assert controller.states == [(False, 500, True, None)]


def test_tray_sync_treats_an_indefinite_pause_as_paused_without_a_boundary():
    controller = FakeController()

    tracker._sync_tray(
        controller,
        {"show_tray_icon": "1", "tracking_paused": "1"},
        now=1_000,
    )

    assert controller.states == [(True, 0.0, True, None)]


def test_tray_sync_reports_outside_scheduled_hours_separately_from_pause():
    controller = FakeController()

    tracker._sync_tray(
        controller,
        {
            "show_tray_icon": "1",
            "tracking_schedule_enabled": "1",
            "tracking_schedule_days": "",
        },
        now=1_000,
    )

    assert controller.states == [(False, 0.0, False, None)]


def test_tray_sync_defaults_a_missing_visibility_setting_to_visible():
    controller = FakeController()

    assert tracker._sync_tray(controller, {}, now=1_000) is True
    assert controller.enabled == [True]


def test_migration_only_bootstraps_and_exits_without_recording(tmp_path, monkeypatch):
    path = tmp_path / "migration-only.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.setenv("TIME_MIGRATE_ONLY", "1")
    _forbid_background_components(monkeypatch)

    tracker.run()

    conn = db.open_db(path)
    try:
        raw = db.read_settings_raw(conn)
        assert raw["schema_version"] == str(db.SCHEMA_VERSION)
        assert raw["tracker_version"] == config.TRACKER_VERSION
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    finally:
        conn.close()


def test_fresh_database_without_consent_exits_before_recording(tmp_path, monkeypatch):
    path = tmp_path / "no-consent.db"
    monkeypatch.setattr(config, "DB_PATH", path)
    monkeypatch.delenv("TIME_MIGRATE_ONLY", raising=False)
    _forbid_background_components(monkeypatch)

    tracker.run()

    conn = db.open_db(path)
    try:
        raw = db.read_settings_raw(conn)
        assert raw["recording_consent"] == "0"
        assert raw["privacy_onboarding_complete"] == "0"
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    finally:
        conn.close()


# --- Failure throttling ---------------------------------------------------
#
# The tick loop runs every second for as long as the machine is on, and it
# hands every exception to the throttle. A probe that fails persistently must
# leave one usable traceback and a periodic count, not a log file that grows
# by 86,400 identical stack traces a day.


def _raised(exc: BaseException) -> BaseException:
    """Return `exc` carrying a real traceback, leaving no live handler behind."""
    try:
        raise exc
    except BaseException as caught:
        return caught


def _record(throttle, exc: BaseException, now: float) -> None:
    """Record from outside the handler that caught the failure.

    `sys.exc_info()` is empty by the time `record` runs, so the logged
    traceback can only have come from the exception it was handed. Reverting
    to `logging.exception` fails these tests instead of silently logging
    `NoneType: None` where support needs a stack.
    """
    throttle.record("tick failed", _raised(exc), now)


def test_first_failure_of_each_kind_logs_a_full_traceback(caplog):
    throttle = tracker.FailureThrottle(summary_seconds=60.0)

    with caplog.at_level(logging.ERROR):
        _record(throttle, OSError("device busy"), 0.0)
        _record(throttle, ValueError("bad row"), 0.0)

    assert [r.getMessage() for r in caplog.records] == [
        "tick failed (OSError)",
        "tick failed (ValueError)",
    ]
    assert [r.exc_info[0] for r in caplog.records] == [OSError, ValueError]
    assert all(r.exc_info[2] is not None for r in caplog.records)


def test_repeated_identical_failures_stay_silent_within_the_interval(caplog):
    throttle = tracker.FailureThrottle(summary_seconds=60.0)

    with caplog.at_level(logging.ERROR):
        for tick in range(60):
            _record(throttle, OSError("device busy"), float(tick))

    assert len(caplog.records) == 1


def test_summary_reports_the_suppressed_count_and_starts_a_new_interval(caplog):
    throttle = tracker.FailureThrottle(summary_seconds=60.0)

    with caplog.at_level(logging.ERROR):
        for tick in (0.0, 10.0, 20.0, 60.0):
            _record(throttle, OSError("device busy"), tick)
        # A new interval opened at t=60, so this one is silent again...
        _record(throttle, OSError("device busy"), 70.0)
        # ...until that interval elapses too, counting only from the summary.
        _record(throttle, OSError("device busy"), 130.0)

    assert [r.getMessage() for r in caplog.records] == [
        "tick failed (OSError)",
        "tick failed: 3 further OSError failures in the last 60s",
        "tick failed: 2 further OSError failures in the last 70s",
    ]
    # A summary is a count, not an incident; it carries no stack of its own.
    assert caplog.records[1].exc_info is None


def test_failure_kinds_are_throttled_independently(caplog):
    throttle = tracker.FailureThrottle(summary_seconds=60.0)

    with caplog.at_level(logging.ERROR):
        _record(throttle, OSError("device busy"), 0.0)
        _record(throttle, OSError("device busy"), 30.0)
        # A different failure mid-interval is new evidence, not a repeat.
        _record(throttle, ValueError("bad row"), 30.0)

    assert [r.getMessage() for r in caplog.records] == [
        "tick failed (OSError)",
        "tick failed (ValueError)",
    ]
