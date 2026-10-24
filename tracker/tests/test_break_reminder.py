"""Break reminder timing, driven by synthetic one-second polls."""

from __future__ import annotations

from dataclasses import replace

from tracker.break_reminder import BreakReminder
from tracker.session_manager import LOCK_PROCESS, Settings, Snapshot

# Stated rather than inherited from the shipped defaults, so changing a default
# cannot quietly move what these tests are about.
IDLE_THRESHOLD = 300.0
INTERVAL = 3600.0
SETTINGS = Settings(
    idle_threshold_seconds=IDLE_THRESHOLD,
    break_reminder_enabled=True,
    break_reminder_seconds=INTERVAL,
)


def snap(now, *, idle=0.0, process="code.exe", media=False):
    return Snapshot(now=now, idle_seconds=idle, process=process, title="", media_playing=media)


def drive(reminder, start, seconds, settings=SETTINGS, **kwargs):
    """Poll once per second from `start`; return the times a reminder was due."""
    due = []
    for t in range(int(start), int(start + seconds)):
        if reminder.observe(snap(float(t), **kwargs), settings) is not None:
            due.append(float(t))
    return due


def test_fires_once_when_the_interval_is_reached():
    reminder = BreakReminder()
    assert drive(reminder, 0, 3 * INTERVAL) == [INTERVAL]


def test_reports_the_stretch_in_minutes():
    reminder = BreakReminder()
    results = [reminder.observe(snap(float(t)), SETTINGS) for t in range(int(INTERVAL) + 1)]
    assert [r for r in results if r is not None] == [60]


def test_a_break_rearms_it_for_the_next_full_interval():
    reminder = BreakReminder()
    assert drive(reminder, 0, INTERVAL + 1) == [INTERVAL]
    # Away past the AFK threshold: the idle counter reaches it, which is a break.
    reminder.observe(snap(INTERVAL + 1, idle=IDLE_THRESHOLD), SETTINGS)
    restart = INTERVAL + 2
    assert drive(reminder, restart, INTERVAL + 1) == [restart + INTERVAL - 1]


def test_idle_below_the_threshold_still_counts_as_activity():
    reminder = BreakReminder()
    drive(reminder, 0, 1000)
    drive(reminder, 1000, 200, idle=IDLE_THRESHOLD - 1)  # reading, not away
    assert drive(reminder, 1200, INTERVAL) == [INTERVAL]


def test_idle_at_the_threshold_starts_over():
    reminder = BreakReminder()
    drive(reminder, 0, INTERVAL - 10)
    reminder.observe(snap(INTERVAL - 10, idle=IDLE_THRESHOLD), SETTINGS)
    assert drive(reminder, INTERVAL - 9, 100) == []


def test_the_lock_screen_is_a_break():
    reminder = BreakReminder()
    drive(reminder, 0, INTERVAL - 10)
    reminder.observe(snap(INTERVAL - 10, process=LOCK_PROCESS), SETTINGS)
    assert drive(reminder, INTERVAL - 9, 100) == []


def test_hands_off_media_holds_the_count_without_resetting_it():
    reminder = BreakReminder()
    drive(reminder, 0, 1800)
    # A two-hour film: idle past the threshold, but media is playing.
    assert drive(reminder, 1800, 7200, idle=IDLE_THRESHOLD + 60, media=True) == []
    # The first half-hour still stands; another half-hour completes the hour.
    assert drive(reminder, 9000, 1801) == [10800.0]


def test_media_with_input_is_ordinary_activity():
    reminder = BreakReminder()
    assert drive(reminder, 0, INTERVAL + 1, media=True) == [INTERVAL]


def test_pause_schedule_and_consent_each_start_fresh():
    for blocked in (
        replace(SETTINGS, tracking_paused=True),
        replace(SETTINGS, recording_schedule_allowed=False),
        replace(SETTINGS, recording_consent=False),
    ):
        reminder = BreakReminder()
        drive(reminder, 0, INTERVAL - 10)
        assert drive(reminder, INTERVAL - 10, 5, settings=blocked) == []
        # Resumed: the earlier stretch is forgotten, so nothing is due soon.
        assert drive(reminder, INTERVAL - 5, 100) == []
        assert drive(reminder, INTERVAL + 95, INTERVAL) == [INTERVAL - 5 + INTERVAL]


def test_disabled_never_fires_and_enabling_starts_from_zero():
    reminder = BreakReminder()
    off = replace(SETTINGS, break_reminder_enabled=False)
    assert drive(reminder, 0, 2 * INTERVAL, settings=off) == []
    assert drive(reminder, 2 * INTERVAL, INTERVAL + 1) == [3 * INTERVAL]


def test_an_unobserved_gap_as_long_as_a_break_starts_over():
    reminder = BreakReminder()
    drive(reminder, 0, INTERVAL - 10)
    # Asleep for the AFK threshold: no polls, then an active one.
    resumed = INTERVAL - 11 + IDLE_THRESHOLD
    assert drive(reminder, resumed, 100) == []


def test_a_shorter_gap_counts_as_the_activity_it_interrupted():
    reminder = BreakReminder()
    drive(reminder, 0, 1000)
    # A slow tick of a minute; the user was at the machine either side of it.
    assert drive(reminder, 1059, INTERVAL) == [INTERVAL]


def test_a_clock_stepped_backwards_adds_nothing():
    reminder = BreakReminder()
    drive(reminder, 10_000, 1000)
    drive(reminder, 5_000, 1000)  # stepped back 6000 s, then continued
    # 1000 s before the step plus 999 polls after it (the step itself adds 0).
    assert drive(reminder, 6_000, INTERVAL) == [6_000 + INTERVAL - 1999]


def test_a_new_interval_applies_mid_stretch():
    reminder = BreakReminder()
    drive(reminder, 0, 1000)
    shorter = replace(SETTINGS, break_reminder_seconds=900.0)
    # Already past the new interval: due on the very next poll.
    assert drive(reminder, 1000, 10, settings=shorter) == [1000.0]
