"""Power notifications are normalized without touching the live Win32 API."""

from __future__ import annotations

from tracker.power_events import (
    PBT_APMRESUMEAUTOMATIC,
    PBT_APMRESUMESUSPEND,
    PBT_APMSUSPEND,
    PowerEvent,
    PowerEventMonitor,
)


def clock(*values: float):
    ticks = iter(values)
    return lambda: next(ticks)


def test_suspend_and_automatic_resume_form_one_cycle():
    monitor = PowerEventMonitor(clock(1000.0, 4600.0))
    monitor._record_notification(PBT_APMSUSPEND)
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)
    assert monitor.drain() == [
        PowerEvent("suspend", 1000.0),
        PowerEvent("resume", 4600.0, suspend_observed=True),
    ]


def test_user_present_resume_is_not_a_second_boundary():
    monitor = PowerEventMonitor(clock(1000.0, 4600.0))
    monitor._record_notification(PBT_APMSUSPEND)
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)
    monitor.drain()
    monitor._record_notification(PBT_APMRESUMESUSPEND)
    assert monitor.drain() == []


def test_automatic_resume_without_suspend_is_preserved_as_fallback():
    monitor = PowerEventMonitor(clock(4600.0))
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)
    assert monitor.drain() == [
        PowerEvent("resume", 4600.0, suspend_observed=False)
    ]


def test_user_present_resume_is_fallback_when_automatic_resume_is_missing():
    monitor = PowerEventMonitor(clock(1000.0, 4600.0))
    monitor._record_notification(PBT_APMSUSPEND)
    monitor._record_notification(PBT_APMRESUMESUSPEND)

    assert monitor.drain() == [
        PowerEvent("suspend", 1000.0),
        PowerEvent("resume", 4600.0, suspend_observed=True),
    ]


def test_user_present_closes_cycle_and_allows_an_unpaired_second_wake():
    monitor = PowerEventMonitor(clock(1000.0, 4600.0, 4700.0))
    monitor._record_notification(PBT_APMSUSPEND)
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)
    monitor._record_notification(PBT_APMRESUMESUSPEND)
    monitor._record_notification(PBT_APMRESUMESUSPEND)
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)

    assert monitor.drain() == [
        PowerEvent("suspend", 1000.0),
        PowerEvent("resume", 4600.0, suspend_observed=True),
        PowerEvent("resume", 4700.0, suspend_observed=False),
    ]


def test_duplicate_suspend_and_resume_notifications_are_coalesced():
    monitor = PowerEventMonitor(clock(1000.0, 4600.0))
    monitor._record_notification(PBT_APMSUSPEND)
    monitor._record_notification(PBT_APMSUSPEND)
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)
    monitor._record_notification(PBT_APMRESUMEAUTOMATIC)
    assert monitor.drain() == [
        PowerEvent("suspend", 1000.0),
        PowerEvent("resume", 4600.0, suspend_observed=True),
    ]
