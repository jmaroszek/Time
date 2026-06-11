# Apps tab

Where raw tracking becomes meaning: every app and domain, and the rules that
classify them.

![Apps tab](images/apps.png)

## Apps & Domains in Range

Everything seen in the selected range — processes and browser domains in one
list — with time, share of the total, and current category. The dropdown on
each row is a shortcut: pick a category and the matching rule is created on
the spot.

Domains get their own rows because of browser title parsing: with a
"URL in title" extension installed, `github.com` time can be classified as
Dev while `youtube.com` time counts as Media, even though both are Chrome.

## Categories

Categories are user-defined, colored, and flagged productive or not — those
flags drive every productive-time metric in the app. The built-in **Ignored**
bucket removes anything assigned to it (launchers, system shell noise) from
every visualization.

## Rules

Classification is rule-based with priorities: **domain (300) > title (200) >
process (100)**. A browser session matching a domain rule beats the generic
"chrome.exe → Browsing" rule; everything else falls through to its process
rule. Rules are evaluated live in the dashboard, so re-categorizing
retroactively reclassifies all history — nothing is baked in at record time.
