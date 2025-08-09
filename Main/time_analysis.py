#!/usr/bin/env python3
from datetime import datetime, timedelta

import config


def parse_date(date_str):
    """Creates a datetime object from a string in MM/DD/YYYY format."""
    return datetime.strptime(date_str, "%m/%d/%y")


def get_timestamp_bounds(start_str, end_str):
    """
    Return UNIX timestamp bounds for the given date range.
    The end timestamp covers the full day.
    """
    start_date = parse_date(start_str)
    end_date = parse_date(end_str)
    start_ts = start_date.timestamp()
    end_ts = (end_date + timedelta(days=1) - timedelta(seconds=1)).timestamp()
    return start_ts, end_ts


def get_daily_use(conn, start_ts, end_ts):
    """
    Retrieve per-process daily usage.
    Returns a dict mapping each day (YYYY-MM-DD) to a list of tuples:
      (process_name, window_title, total_seconds).
    """
    query = """
    SELECT
        date(timestamp, 'unixepoch', 'localtime') AS day,
        process_name,
        window_title,
        SUM(poll_rate) AS total_seconds
    FROM time_log
    WHERE timestamp BETWEEN ? AND ?
    GROUP BY day, process_name, window_title
    ORDER BY day ASC, total_seconds DESC;
    """
    cur = conn.cursor()
    cur.execute(query, (start_ts, end_ts))
    rows = cur.fetchall()

    daily_usage = {}
    for day, proc, window_title, secs in rows:
        daily_usage.setdefault(day, []).append((proc, window_title, secs))

    return daily_usage


def get_total_use(conn, start_ts, end_ts):
    """
    Retrieve total usage per process over the entire interval.
    Returns a list of tuples (process_name, total_seconds) sorted by total_seconds descending.
    """
    query = """
    SELECT process_name,
           SUM(poll_rate) AS total_seconds
    FROM time_log
    WHERE timestamp BETWEEN ? AND ?
    GROUP BY process_name
    ORDER BY total_seconds DESC;
    """
    cur = conn.cursor()
    cur.execute(query, (start_ts, end_ts))
    return cur.fetchall()


def get_daily_productivity(daily_usage):
    daily_categories = {}
    productive_set = {app.lower() for app in config.PRODUCTIVE_APPS}
    keywords = {kw.lower() for kw in config.UNPRODUCTIVE_CHROME_KEYWORDS}

    for day, entries in daily_usage.items():
        daily_categories[day] = {"Productive": 0, "Non-Productive": 0}

        for process, window_title, seconds in entries:
            proc = process.lower()
            title = (window_title or "").lower()
            if proc == "chrome.exe":
                # see which keywords actually match
                matches = [kw for kw in keywords if kw in title]
                if matches:
                    category = "Non-Productive"
                else:
                    category = "Productive"
            else:
                category = "Productive" if proc in productive_set else "Non-Productive"
            daily_categories[day][category] += seconds

    return daily_categories


def get_interval_stats(total_use, daily_productivity):
    total_time = sum(seconds for _, seconds in total_use)

    sum_prod = sum(day.get("Productive", 0) for day in daily_productivity.values())
    sum_non = sum(day.get("Non-Productive", 0) for day in daily_productivity.values())

    day_count = len(daily_productivity)

    total_prod = sum_prod
    total_nonprod = sum_non

    avg_prod = (sum_prod / day_count) if day_count else 0
    avg_nonprod = (sum_non / day_count) if day_count else 0

    ratio = total_prod / total_nonprod if total_nonprod > 0 else float("inf")

    return {
        "total_time": total_time,
        "total_prod": total_prod,
        "total_nonprod": total_nonprod,
        "avg_prod_per_day": avg_prod,
        "avg_nonprod_per_day": avg_nonprod,
        "ratio": ratio,
        "n_days": day_count,
    }


# Do not delete this even though it is a case of the function below it.
# I do not want to refactor.
def get_last_weeks_bounds():
    """
    Calculate the full last week based on the global WEEK_START.
    For example, if WEEK_START is 'Sunday' and today is Wednesday,
    the function returns the UNIX timestamps for the first and last day of last week.
    The last day's timestamp extends to the end of the day.

    Returns:
        Tuple (float, float): UNIX timestamps for the start and end of last week.
    """
    # Mapping of week start names to weekday numbers (Monday=0, ..., Sunday=6)
    days_mapping = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    week_start_idx = days_mapping[config.WEEK_START.lower()]

    # Determine today's date
    today = datetime.now().date()

    # Calculate the start date of the current week.
    # (today.weekday() returns Monday=0, ..., Sunday=6)
    delta = (today.weekday() - week_start_idx) % 7
    current_week_start = today - timedelta(days=delta)

    # The last week starts 7 days before the current week's start
    last_week_start = current_week_start - timedelta(days=7)

    # Generate the first and last day of last week
    first_day = last_week_start
    last_day = last_week_start + timedelta(days=6)

    # Convert to UNIX timestamps
    first_bound = datetime.combine(first_day, datetime.min.time()).timestamp()
    last_bound = datetime.combine(last_day, datetime.max.time()).timestamp()

    return first_bound, last_bound


def get_last_n_weeks_bounds(n):
    """
    Calculate the full last n weeks based on the global WEEK_START.
    The last n weeks do not include any days from this current week.

    For example, if WEEK_START is 'Sunday' and today is Wednesday,
    then for n=1, the function returns the UNIX timestamps for the first
    and last day of last week.

    For n=2, it returns the bounds for the period covering the two full weeks
    before this week.

    Args:
        n (int): Number of full weeks to go back.

    Returns:
        Tuple (float, float): UNIX timestamps for the start of the earliest week
                                in the period and the end of last week.
    """
    # Mapping of week start names to weekday numbers (Monday=0, ..., Sunday=6)
    days_mapping = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    week_start_idx = days_mapping[config.WEEK_START.lower()]

    # Determine today's date
    today = datetime.now().date()

    # Calculate the start date of the current week.
    # (today.weekday() returns Monday=0, ..., Sunday=6)
    delta = (today.weekday() - week_start_idx) % 7
    current_week_start = today - timedelta(days=delta)

    # The period we want ends at the last moment of the day immediately before the current week begins.
    last_day = current_week_start - timedelta(days=1)

    # The period starts at the beginning of the week n weeks prior to the current week.
    first_day = current_week_start - timedelta(weeks=n)

    # Convert these dates to UNIX timestamps
    first_bound = datetime.combine(first_day, datetime.min.time()).timestamp()
    last_bound = datetime.combine(last_day, datetime.max.time()).timestamp()

    return first_bound, last_bound


def get_this_weeks_bounds():
    """
    Calculate the current week's bounds based on the global WEEK_START.
    For example, if WEEK_START is 'Sunday' and today is Wednesday,
    the function returns the UNIX timestamps for the start of this week (Sunday) to today.
    The start timestamp begins at midnight of WEEK_START, and the end timestamp extends to the end of today.

    Returns:
        Tuple (float, float): UNIX timestamps for the start of this week and the end of today.
    """
    # Mapping of week start names to weekday numbers (Monday=0, ..., Sunday=6)
    days_mapping = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    week_start_idx = days_mapping[config.WEEK_START.lower()]

    # Determine today's date
    today = datetime.now().date()

    # Calculate the start date of the current week.
    # (today.weekday() returns Monday=0, ..., Sunday=6)
    delta = (today.weekday() - week_start_idx) % 7
    current_week_start = today - timedelta(days=delta)

    # Generate the first day of this week and today
    first_day = current_week_start
    last_day = today

    # Convert to UNIX timestamps
    first_bound = datetime.combine(first_day, datetime.min.time()).timestamp()
    last_bound = datetime.combine(last_day, datetime.max.time()).timestamp()

    return first_bound, last_bound


# --- formatting ---


def format_duration(seconds):
    """Convert seconds to a hh:mm:ss formatted string."""
    return str(timedelta(seconds=round(seconds)))


def clean_process_name(process_name: str, max_len: int = 15):
    if process_name == "r5apex_dx12.exe":
        process_name = "apex"
    name = process_name.capitalize().removesuffix(".exe")
    name = name if len(name) <= max_len else name[:max_len] + "..."
    return name
