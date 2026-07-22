# Activity tab

Activity is the record-management side of Time: review what was recorded,
search it, classify it, correct friendly names, inspect sessions, and delete an
exact scope. Insights remains the analytical side, turning a selected range
into charts, totals, comparisons, and trends.

![Activity tab](images/apps.png)

Activity and Insights share the date picker in the top-right. Switching tabs
does not reset it. Every Activity total, result, and Needs Attention item uses
that visible range; a quiet **Try All time** action appears when a search finds
nothing in a narrower range.

## Activity Library

With no search text, the Library is a complete catalog of Apps and Websites in
the visible range. It includes ignored and short activity, excludes AFK
identities, and never uses Insights' minimum-app threshold. Name, classification,
time, last seen, and session count can be sorted; large catalogs load 100 items
at a time.

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

**Needs Attention** surfaces every identity with uncategorized time, including
brief activity. Its six largest items can be classified directly, **Show all**
applies the matching filter, and an all-history count can move the shared date
picker to All time.

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

## Categories & Rules

The second internal view manages classification. Categories start collapsed;
the chevron alone opens their rules, and the pencil alone renames them. Enter or
focus-out saves a name and Escape cancels, so ordinary spaces never toggle the
row. The built-in Ignored category cannot be renamed or deleted. Trash buttons
remove ordinary categories and rules, with category/rule counts confirmed
before category deletion.

The interface uses plain rule names while keeping the same matching behavior:

| Rule | What it matches |
| --- | --- |
| **Website** | A detected site such as `github.com`; paths and searches are not stored. |
| **Window** | Words in a stored browser window title. Title capture is optional and off by default. |
| **App** | The foreground executable, such as `code.exe`. |

When several rules match, Website wins, then Window, then App. Rules are
evaluated against history instead of baked into session rows, so edits
reclassify existing and future activity. All-time category and rule usage shows
which rules actually win, including applied session count, duration, and last
use; overridden or unused rules say **No applied activity**.
