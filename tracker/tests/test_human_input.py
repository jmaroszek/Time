from tracker import human_input


def test_initial_idle_uses_windows_last_input_tick():
    clock = human_input._HumanInputClock(now_ms=20_500, last_input_tick=18_000)

    assert clock.idle_seconds(20_500, 18_000) == 2.5


def test_injected_input_does_not_reset_human_idle():
    clock = human_input._HumanInputClock(now_ms=100_000, last_input_tick=90_000)
    clock.record_hook_event(100_100, injected=True, now_ms=100_100)

    assert clock.idle_seconds(100_500, 100_100) == 10.5
    # The same latest Windows input remains classified as injected after the
    # short matching window has elapsed.
    assert clock.idle_seconds(120_500, 100_100) == 30.5


def test_injected_tick_matching_tolerates_small_windows_timestamp_skew():
    clock = human_input._HumanInputClock(now_ms=100_000, last_input_tick=90_000)
    clock.record_hook_event(100_100, injected=True, now_ms=100_100)

    assert clock.idle_seconds(100_500, 100_120) == 10.5


def test_injected_provenance_survives_a_short_polling_stall():
    clock = human_input._HumanInputClock(now_ms=100_000, last_input_tick=90_000)
    clock.record_hook_event(100_100, injected=True, now_ms=100_100)

    assert clock.idle_seconds(150_000, 100_100) == 60.0


def test_physical_hook_event_resets_human_idle():
    clock = human_input._HumanInputClock(now_ms=100_000, last_input_tick=90_000)
    clock.record_hook_event(100_100, injected=False, now_ms=100_125)

    assert clock.idle_seconds(100_500, 100_100) == 0.375


def test_physical_input_just_before_injected_input_is_not_lost():
    clock = human_input._HumanInputClock(now_ms=100_000, last_input_tick=90_000)
    clock.record_hook_event(100_100, injected=False, now_ms=100_100)
    clock.record_hook_event(100_110, injected=True, now_ms=100_110)

    assert clock.idle_seconds(100_500, 100_110) == 0.4


def test_unmatched_windows_input_fails_toward_active():
    clock = human_input._HumanInputClock(now_ms=100_000, last_input_tick=90_000)

    # If the hook misses an event, LASTINPUTINFO still moves and is treated as
    # human. A hook failure may preserve the old behavior, but cannot create a
    # false AFK interval while the user is present.
    assert clock.idle_seconds(101_000, 100_500) == 0.5


def test_tick_expansion_handles_32_bit_wraparound():
    now_ms = 0x1_0000_0200
    clock = human_input._HumanInputClock(now_ms, 0xFFFF_FE00)

    assert clock.idle_seconds(now_ms, 0xFFFF_FE00) == 1.024


def test_inactive_monitor_uses_windows_idle_fallback():
    ticks = iter((20_000, 20_500))
    monitor = human_input.HumanInputMonitor(
        tick_clock=lambda: next(ticks),
        last_input_reader=lambda: 18_000,
    )

    assert monitor.idle_seconds() == 2.5


def test_start_failure_returns_fallback_without_private_error_text(monkeypatch, caplog):
    class BrokenMonitor:
        def __init__(self):
            self.close_calls = 0

        def start(self):
            raise OSError("private hook detail")

        def close(self):
            self.close_calls += 1

    monitor = BrokenMonitor()
    monkeypatch.setattr(human_input, "HumanInputMonitor", lambda: monitor)

    with caplog.at_level("ERROR"):
        assert human_input.start_human_input_monitor() is None

    assert monitor.close_calls == 1
    assert "OSError" in caplog.text
    assert "private hook detail" not in caplog.text
