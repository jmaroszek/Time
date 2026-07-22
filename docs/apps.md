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
never uses Insights' minimum-app threshold. Name, classification, time, last
seen, and session count can be sorted. The table sits in a fixed-height region
with its header row pinned, and loads 50 items at a time, so **Load more**
deepens that region instead of stretching the page.

The card header counts how many items are in range, and — when there are any —
how many carry uncategorized time. Clicking that count applies the
**Uncategorized** filter, and clicking it again clears it. Rows the noise fold
hides are left out of the count as well as the list, so the two always agree.

### Folded rows

A tracker records every foreground window, so the raw catalog carries rows
nobody wants to track. Two tests fold those out of the list:

- **One-off** — the item is under the time limit **and** at or under the session
  limit. Both halves are required, so a 15-second app opened twenty times stays
  in the list, and so does a single forty-minute sitting.
- **Utility** — the name marks it as a machine chore rather than an
  application: installers, updaters, driver and firmware bundles, extracted
  `.tmp` payloads, Windows plumbing, and local files rendered in a browser.
  These fold regardless of duration, because an install can run for twenty
  minutes.

Folding is a view filter over this one list. It never changes a total, an
Insights figure, or what an entity contributes to its category, and anything
already carrying a category or rule is never folded — an explicit decision
outranks the heuristic. The Library header reports how many rows are folded and
shows them on demand, tagged **One-off** or **Utility**; searching reaches past
the fold, so a search for `setup` still finds the installers. Settings ▸
Activity Library sets the mode and both limits, or turns folding off.

One search field covers friendly names, cleaned and recorded app names,
websites, and stored window titles. Search results are separated into:

- **Apps** — matching executable identities.
- **Websites** — matching website identities detected in supported browsers.
- **Window matches** — individual sessions whose stored title contains the
  search text, with time, duration, identity, category, and winning rule.

Stored titles are not listed until a search is entered. Historical titles
remain searchable if future title capture is later disabled. The type filter
narrows Apps and Websites; Window matches stay separately labeled. Date and
classification filters apply throughout.

Classification status describes the activity represented by the current range:

- **Uncategorized** has no categorized time.
- **Partially categorized** has categorized and uncategorized time, so it still
  needs attention.
- **Mixed** has more than one category across its sessions.
- A category name means all represented time resolves to that one category.
- **Ignored** means all represented activity is excluded from Insights.

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
usage in context lives in each item's details, under **Rules in use**.

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
