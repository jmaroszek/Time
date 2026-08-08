import datetime as dt

from tracker.tracking_schedule import schedule_state


def _timestamp(year, month, day, hour, minute=0):
    return dt.datetime(year, month, day, hour, minute).timestamp()


BASE = {
    "tracking_schedule_enabled": "1",
    "tracking_schedule_days": "0,1,2,3,4",
    "tracking_schedule_start_minute": "540",
    "tracking_schedule_end_minute": "1020",
}


def test_daytime_schedule_includes_start_and_excludes_end():
    monday_start = schedule_state(BASE, _timestamp(2026, 8, 3, 9))
    assert monday_start.recording_allowed is True
    assert monday_start.current_window_start == _timestamp(2026, 8, 3, 9)

    monday_end = schedule_state(BASE, _timestamp(2026, 8, 3, 17))
    assert monday_end.recording_allowed is False
    assert monday_end.next_start == _timestamp(2026, 8, 4, 9)


def test_overnight_window_uses_the_day_on_which_it_starts():
    overnight = {
        **BASE,
        "tracking_schedule_days": "0",
        "tracking_schedule_start_minute": "1320",
        "tracking_schedule_end_minute": "360",
    }
    assert schedule_state(overnight, _timestamp(2026, 8, 3, 23)).recording_allowed
    tuesday = schedule_state(overnight, _timestamp(2026, 8, 4, 5, 59))
    assert tuesday.recording_allowed
    assert tuesday.current_window_start == _timestamp(2026, 8, 3, 22)
    assert not schedule_state(overnight, _timestamp(2026, 8, 4, 6)).recording_allowed


def test_enabled_invalid_schedule_fails_closed():
    no_days = schedule_state({**BASE, "tracking_schedule_days": ""}, 1_000)
    assert no_days.valid is False
    assert no_days.recording_allowed is False

    equal = schedule_state(
        {**BASE, "tracking_schedule_end_minute": BASE["tracking_schedule_start_minute"]},
        1_000,
    )
    assert equal.valid is False
    assert equal.recording_allowed is False


def test_disabled_schedule_does_not_gate_recording():
    state = schedule_state({**BASE, "tracking_schedule_enabled": "0"}, 1_000)
    assert state.enabled is False
    assert state.recording_allowed is True
