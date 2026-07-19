# Overview tab

This tab focuses on your recent behavior. The date picker in the top-right corner offers Today, Last 7/14/28 days, and a custom range.

![Overview tab](images/overview.png)

## KPI cards

| Card | What it measures |
| --- | --- |
| **Average productivity per day** | Productive time in the range divided by its calendar days. |
| **Productivity percent** | Share of non-AFK time spent in categories marked productive. |
| **Longest focus** | The longest unbroken chain of productive sessions. Switching between productive apps keeps the chain alive (gaps up to the "Focus chain max gap" setting, 2 minutes by default, are forgiven); going AFK or drifting to a non-productive app breaks it. |
| **Goal pace** | Productive hours in the range against the weekly goal prorated to the range's length - a trailing measure, deliberately not a catch-up rate. |

## Timeline

Each row is a day; each block is time on one category, color-coded, at a
selectable resolution (5/10/15/30-minute blocks, or exact session segments).
Dim gray blocks are AFK. The shape of a day is instantly readable — morning
browse, two work blocks around lunch, the evening tail.

## Top Apps

Apps ranked by time in range, with a delta against the previous period of the
same length. Deltas are colored only when a Welch's t-test on day-by-day usage
says the change is statistically significant — and the color is
category-aware: *more* time in a productive app is green, more time in a
non-productive one is red, and vice versa for declines.

## Daily Hours

Stacked productive vs non-productive hours per day, with a trailing 7-day
average of productive time to show the trend through the noise.
