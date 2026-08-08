"""Recurring local-time recording windows shared by tracker entry points.

Days use Python's Monday=0 convention. For an overnight window, the selected
day is the day the window starts: Monday 22:00-06:00 continues into Tuesday.
"""

from __future__ import annotations

import datetime as dt
import time
from dataclasses import dataclass


DEFAULT_DAYS = "0,1,2,3,4"
DEFAULT_START_MINUTE = 9 * 60
DEFAULT_END_MINUTE = 17 * 60


@dataclass(frozen=True)
class ScheduleState:
    enabled: bool
    valid: bool
    recording_allowed: bool
    current_window_start: float | None
    next_start: float | None


def _parse_minute(raw: str | None, fallback: int) -> int:
    try:
        value = int(raw if raw is not None else fallback)
    except (TypeError, ValueError):
        return fallback
    return value if 0 <= value < 24 * 60 else fallback


def _parse_days(raw: str | None) -> frozenset[int]:
    days: set[int] = set()
    for token in (raw or "").split(","):
        try:
            day = int(token.strip())
        except ValueError:
            continue
        if 0 <= day <= 6:
            days.add(day)
    return frozenset(days)


def _at_minute(day: dt.date, minute: int) -> float:
    local = dt.datetime.combine(
        day,
        dt.time(hour=minute // 60, minute=minute % 60),
    )
    return local.timestamp()


def schedule_state(
    raw: dict[str, str],
    now: float | None = None,
) -> ScheduleState:
    """Evaluate the recurring schedule in the computer's current local time."""
    if raw.get("tracking_schedule_enabled") != "1":
        return ScheduleState(False, True, True, None, None)

    current_ts = time.time() if now is None else now
    local_now = dt.datetime.fromtimestamp(current_ts)
    days = _parse_days(raw.get("tracking_schedule_days", DEFAULT_DAYS))
    start = _parse_minute(
        raw.get("tracking_schedule_start_minute"), DEFAULT_START_MINUTE
    )
    end = _parse_minute(raw.get("tracking_schedule_end_minute"), DEFAULT_END_MINUTE)
    if not days or start == end:
        return ScheduleState(True, False, False, None, None)

    second_of_day = (
        local_now.hour * 3600
        + local_now.minute * 60
        + local_now.second
        + local_now.microsecond / 1_000_000
    )
    start_second = start * 60
    end_second = end * 60
    today = local_now.date()
    weekday = local_now.weekday()
    window_start: float | None = None

    if start < end:
        if weekday in days and start_second <= second_of_day < end_second:
            window_start = _at_minute(today, start)
    elif weekday in days and second_of_day >= start_second:
        window_start = _at_minute(today, start)
    elif (weekday - 1) % 7 in days and second_of_day < end_second:
        window_start = _at_minute(today - dt.timedelta(days=1), start)

    next_start: float | None = None
    for offset in range(8):
        candidate_day = today + dt.timedelta(days=offset)
        if candidate_day.weekday() not in days:
            continue
        candidate = _at_minute(candidate_day, start)
        if candidate > current_ts:
            next_start = candidate
            break

    return ScheduleState(
        enabled=True,
        valid=True,
        recording_allowed=window_start is not None,
        current_window_start=window_start,
        next_start=next_start,
    )
