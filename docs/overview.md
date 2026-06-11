# Overview tab

This tab focuses on your recent behavior. The dropdown menu in the top-right corner allows you to select options such as "last 7 days," "last 14 days," and "last 4 weeks"

![Overview tab](images/overview.png)

## KPI cards

| Card | What it measures |
| --- | --- |
| **Total Time** | Non-AFK time at the computer in the selected range. |
| **Productive** | Share of that time spent in categories marked productive, with the absolute hours underneath. |
| **Longest Focus** | The longest unbroken chain of productive sessions. Switching between productive apps keeps the chain alive (gaps up to 60 s are forgiven); going AFK or drifting to a non-productive app breaks it. |
| **Goal Pace** | Productive hours against the weekly goal, scaled to the range. When behind, it shows the hours-per-day needed to catch up. |

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
