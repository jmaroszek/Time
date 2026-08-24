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


def test_loop_continuity_reports_nothing_on_its_first_poll():
    continuity = tracker.LoopContinuity(gap_seconds=60.0)
    assert continuity.gap_before(1000.0) == 0.0


def test_loop_continuity_stays_quiet_while_the_loop_keeps_up():
    continuity = tracker.LoopContinuity(gap_seconds=60.0)
    continuity.gap_before(1000.0)
    assert continuity.gap_before(1001.0) == 0.0
    assert continuity.gap_before(1030.0) == 0.0  # a slow tick is still watching


def test_loop_continuity_reports_an_interval_the_loop_missed():
    continuity = tracker.LoopContinuity(gap_seconds=60.0)
    continuity.gap_before(1000.0)
    assert continuity.gap_before(11000.0) == 10000.0
    # The gap is reported once; the poll after it is continuous again.
    assert continuity.gap_before(11001.0) == 0.0


def test_loop_continuity_never_reports_a_clock_set_back_as_a_gap():
    continuity = tracker.LoopContinuity(gap_seconds=60.0)
    continuity.gap_before(10000.0)
    assert continuity.gap_before(9400.0) == 0.0


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


class RecordingConn:
    """Captures settings writes, and can be made to fail them."""

    def __init__(self, fail=False):
        self.writes = []
        self.fail = fail


def _publish(conn, active, published, monkeypatch):
    def set_setting(target, key, value):
        if target.fail:
            raise RuntimeError("database is locked")
        target.writes.append((key, value))

    monkeypatch.setattr(tracker.db, "set_setting", set_setting)
    return tracker._publish_tray_state(conn, active, published)


def test_tray_state_is_published_once_and_only_when_it_changes(monkeypatch):
    """`show_tray_icon` is what was asked for; this is what happened. Without it
    a tracker that cannot create an icon leaves the switch promising a tray that
    is not there, and the reader loses the only way to pause without opening the
    dashboard.

    Write-on-change matters as much as the value: this runs on every settings
    poll, and a write per second for a value that never moves is a real cost."""
    conn = RecordingConn()

    published = _publish(conn, True, None, monkeypatch)
    assert published is True
    assert conn.writes == [(tracker.TRAY_ACTIVE_KEY, "1")]

    # Unchanged: no second write.
    published = _publish(conn, True, published, monkeypatch)
    assert published is True
    assert conn.writes == [(tracker.TRAY_ACTIVE_KEY, "1")]

    published = _publish(conn, False, published, monkeypatch)
    assert published is False
    assert conn.writes == [
        (tracker.TRAY_ACTIVE_KEY, "1"),
        (tracker.TRAY_ACTIVE_KEY, "0"),
    ]


def test_a_failed_tray_publish_retries_rather_than_recording_a_lie(monkeypatch):
    """The write is best-effort, but "best effort" must not mean pretending it
    landed. Returning the attempted value would leave the dashboard reading a
    stale answer forever, because the next poll would see no change to write."""
    conn = RecordingConn(fail=True)

    assert _publish(conn, True, None, monkeypatch) is None
    assert conn.writes == []

    conn.fail = False
    assert _publish(conn, True, None, monkeypatch) is True
    assert conn.writes == [(tracker.TRAY_ACTIVE_KEY, "1")]
