# Activity tab

Activity is the record-management side of Time: review what was recorded,
search it, classify it, correct friendly names, inspect sessions, and delete an
exact scope. Insights remains the analytical side, turning a selected range
into charts, totals, comparisons, and trends.

![Activity tab](images/apps.png)

Activity and Insights share the date picker in the top-right. Switching tabs
does not reset it. Every Activity total and result uses that visible range; a
quiet **Try All time** action appears when a search finds nothing in a narrower
range.

The tab is one card with two faces, chosen from its title: **Activity Library**
and **Categories & Rules**.

## Activity Library

With no search text, the Library is a complete catalog of Apps and Websites in
the visible range. It includes ignored activity, excludes AFK identities, and
never uses Insights' minimum-app threshold. Four columns, all sortable:

- **Name** — the friendly name, over a quieter line carrying the item's
  classification, whether it is an App or a Website, and any tags.
- **Time** — recorded time in range, drawn as a bar against the busiest row and
  then stated exactly, the same way Insights lists top apps. The heaviest item
  fills the track and everything else is measured against it; hovering a bar
  reports that item's exact share of all recorded time in the range. The scale
  follows the filters, not the loaded page, so **Load more** never redraws the
  bars above it.
- **Days seen** — how many distinct days the item was used on, which separates
  a daily habit from a single long sitting. A session running past midnight
  counts for both days.
- **Last seen** — the time of day for anything seen today, **Yesterday** for
  the day before, and the date beyond that.

Tags sit beside the name, since each describes the item rather than how it has
been classified. Items first recorded anywhere in your history inside the
visible range are tagged **New**; a range reaching back to your first-ever
session tags nothing, because everything would qualify. **Rare** and
**Utility** mark rows the list normally hides, and appear only while those
rows are being shown.

The table fills the window's remaining height, ending just short of the bottom
of the screen, with its header row pinned and 50 items loaded at a time — so
**Load more** deepens the table's own scroll region instead of stretching the
page, and a taller window simply shows more rows. The count of loaded and total
items sits with **Load more** at the foot of the list, where someone scrolling
is asking for it.

The **Uncategorized** filter carries a count of the items it would show.
Rows the noise filter hides are left out of that count as well as the list, so
the two always agree, and the count follows the Apps/Websites filter for the
same reason.

### Hidden rows

A tracker records every foreground window, so the raw catalog carries rows
nobody wants to track. Two tests can hide those from the list:

- **Rare** — across all recorded history, the item is under the time limit
  **and** at or under the session limit. Both halves are required, so a
  15-second app opened twenty times stays in the list, and so does a single
  forty-minute sitting. Because the test uses all history, changing the visible
  date range cannot make a recurring item look rare.
- **Utility** — the name marks it as a machine chore rather than an
  application: installers, updaters, driver and firmware bundles, extracted
  `.tmp` payloads, Windows plumbing, and local files rendered in a browser.
  These are hidden regardless of duration, because an install can run for twenty
  minutes.

This is a view filter over the Activity Library only. It never changes a total, an
Insights figure, or what an entity contributes to its category, and anything
already carrying a category or rule is never hidden — an explicit decision
outranks the heuristic. The Library header reports how many rows are hidden and
shows them on demand, tagged **Rare** or **Utility**; searching reaches past
the filter, so a search for `setup` still finds the installers. Settings ▸
Activity list sets the mode and both limits, or turns filtering off.

### Searching

One search field covers friendly names, cleaned and recorded app names,
websites, and stored window titles. **✕** or Escape clears it and returns the
full catalog. Results come back in two groups, each with its own **Load more**
and a heading that stays pinned while that group is scrolled:

- **Apps and websites** — the catalog itself, narrowed to matching identities.
  It is the same table with the same columns and the same sort, because an
  app and a website are the same kind of row: each already says which it is,
  and the type filter is there to show one kind at a time.
- **Window matches** — individual sessions whose stored title contains the
  search text, newest first, with the matched text marked. A long title is
  windowed so the match stays visible rather than being cut off past the
  column's width, and a leading **…** shows where the title was trimmed.
  Sessions carry their identity, category, winning rule, and duration.

Stored titles are not listed until a search is entered. Historical titles
remain searchable if future title capture is later disabled. Date and
classification filters apply to both groups. The type filter narrows only the
identity group — a stored title belongs to the session rather than to an app or
a website, so narrowing by type would drop the rows a title search is for. The
Window matches heading says **all types** whenever a type filter is set, so the
exception is visible where it applies.

Window matches can be checked for deletion, and the heading's checkbox takes
every row currently loaded — never the unloaded remainder, since a checkbox
should only promise what it can be seen to tick. This selection is separate
from the one in an item's details, so opening an item does not discard it.

### Classification status

Classification status describes the activity represented by the current range,
and leads each row's second line:

- **Uncategorized** has no categorized time.
- **Partly uncategorized** has categorized and uncategorized time, so it still
  needs attention.
- A category name means all represented time resolves to that one category.
  A trailing count, as in *Dev +2*, means the item is categorized differently
  across its sessions; the full split is in its details.
- **Ignored** means all represented activity is excluded from Insights.

### Item details

Selecting an App or Website opens its details: friendly and recorded identity,
first and last seen, time, session count, category distribution, uncategorized
time, rules in use, and newest-first sessions. Window filtering reveals stored
titles only for matching sessions. Set an App default or Website category from
here; the resulting rule applies to all matching historical and future activity,
not just the range being inspected. A more-specific Website or Window rule can
still leave an App with Mixed classification.

## Exact deletion

Activity can delete checked sessions or one exact App or Website identity in
the visible range. The confirmation previews the session count, duration,
earliest and latest timestamps, protected live rows, and the database snapshot
used for deletion. Identity deletion removes complete session rows that overlap
the range, even when a row begins just outside it.

**Back up first** is optional and explicit. Newly recorded rows after the
preview cannot be swept into the operation, and the newest live session is
protected while the tracker is actively recording. Pause recording and retry
after that session closes if it also needs correction. Targeted deletion never
stops the tracker and keeps categories, rules, aliases, settings, and separate
backup files.

## Excluded from tracking

The last entry in the classification filter, **Excluded from tracking**, lists
the apps and websites Time is not allowed to record at all. An exclusion stops
matching activity from ever reaching the database, so it is stronger than any
category or rule and is not a property of anything recorded.

Add one from an App or Website's details with **Do not track…**, or by name
from this list. Adding can optionally delete the matching history it finds,
after showing the count. Lifting an exclusion resumes tracking from that moment
on; history deleted along with it is not restored. Settings shows only how many
exclusions exist.

## Categories & Rules

The second face of the card manages classification. Categories start collapsed;
the chevron opens their rules. Double-click a name to rename it — Enter or
focus-out saves and Escape cancels — and the opened category repeats **Rename**
as a labeled button, which is what keeps renaming reachable from the keyboard.
**Delete category…** sits beside it and confirms the rule count it will take
with it. The built-in Ignored category can do neither.

A category is productive, neutral, or unproductive. Ignoring is not one of
these states: the built-in Ignored category is the single ignore mechanism.
A category left flagged ignored by an older release keeps showing that state
until one of the three is chosen for it.

Rules are removed with a quiet ✕ on their row. Each rule's kind is marked by a
small glyph — a square for App, a titled frame for Window, a globe for Website —
because color in this app means category identity. A rule nothing has ever
matched is tagged **unused**, which is the one case worth acting on; per-rule
usage in context lives in each item's details, under **Rules in use**. A long
rule list scrolls inside its own category rather than pushing the categories
below it off the screen.

The interface uses plain rule names while keeping the same matching behavior:

| Rule | What it matches |
| --- | --- |
| **Website** | A detected site such as `github.com`; paths and searches are not stored. |
| **Window** | Words in a stored browser window title. Title capture is optional and off by default. |
| **App** | The foreground executable, such as `code.exe`. |

When several rules match, Website wins, then Window, then App. Rules are
evaluated against history instead of baked into session rows, so edits
reclassify existing and future activity — which is also why **unused** is
measured against all of history and not the visible range.
