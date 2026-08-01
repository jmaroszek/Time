import { describe, expect, it } from "vitest";

import type { ActivitySource } from "./activity";
import { buildClassifier, DEFAULT_RULE_PRIORITY, type Category, type Rule } from "./classify";
import {
  candidateParents,
  findConsolidation,
  parseDismissed,
  serializeDismissed,
  verifyConsolidation,
} from "./domainConsolidation";
import type { Session } from "./metrics";

const FOCUS = 1;
const MEDIA = 2;
const BROWSING = 3;

const CATEGORIES: Category[] = [
  { id: FOCUS, name: "Focus", color: "#378ADD", isProductive: true, isNeutral: false, isIgnored: false, sortOrder: 1 },
  { id: MEDIA, name: "Media", color: "#D4537E", isProductive: false, isNeutral: false, isIgnored: false, sortOrder: 2 },
  { id: BROWSING, name: "Browsing", color: "#EF9F27", isProductive: false, isNeutral: true, isIgnored: false, sortOrder: 3 },
];

let nextRuleId = 1;
function domainRule(pattern: string, categoryId: number, priority?: number): Rule {
  return {
    id: nextRuleId++,
    matchType: "domain",
    pattern,
    categoryId,
    priority: priority ?? DEFAULT_RULE_PRIORITY.domain,
  };
}

function processRule(pattern: string, categoryId: number): Rule {
  return {
    id: nextRuleId++,
    matchType: "process",
    pattern,
    categoryId,
    priority: DEFAULT_RULE_PRIORITY.process,
  };
}

/** A Window rule scoped to one website, which `effectivePriority` promotes
 *  above every Website rule — the precedence a consolidation must not disturb. */
function windowRuleForDomain(pattern: string, domain: string, categoryId: number): Rule {
  return {
    id: nextRuleId++,
    matchType: "title",
    pattern,
    categoryId,
    priority: DEFAULT_RULE_PRIORITY.title,
    scopeKind: "domain",
    scopeValue: domain,
    titleMatchMode: "phrase",
    titleAnchor: "any",
  };
}

let nextSessionId = 1;
/** Half an hour, so two sessions clear the one-hour materiality floor. */
function browsing(domain: string, seconds = 1800, title = ""): Session {
  const start = nextSessionId * 100_000;
  return {
    id: nextSessionId++,
    start,
    end: start + seconds,
    process: "chrome.exe",
    title,
    domain,
    isAfk: false,
  };
}

function makeSource(rules: Rule[], sessions: Session[]): ActivitySource {
  return {
    sessions,
    categories: CATEGORIES,
    rules,
    browserProcesses: ["chrome.exe"],
    aliases: {},
  };
}

/** Two sessions per domain, which is what clears the materiality floor. */
function trafficFor(domains: string[]): Session[] {
  return domains.flatMap((domain) => [browsing(domain), browsing(domain)]);
}

const GOOGLE_CHILDREN = ["mail.google.com", "docs.google.com", "drive.google.com"];

function googleSource(extraRules: Rule[] = [], extraDomains: string[] = []): ActivitySource {
  return makeSource(
    [...GOOGLE_CHILDREN.map((domain) => domainRule(domain, FOCUS)), ...extraRules],
    trafficFor([...GOOGLE_CHILDREN, ...extraDomains]),
  );
}

describe("public suffixes are never proposed", () => {
  it("refuses co.uk even though three rules share it", () => {
    const rules = ["bbc.co.uk", "guardian.co.uk", "telegraph.co.uk"].map((d) => domainRule(d, FOCUS));
    expect(candidateParents(rules)).toEqual([]);
  });

  it("still proposes a real registrable name under the same suffix", () => {
    const rules = ["a.bbc.co.uk", "b.bbc.co.uk", "c.bbc.co.uk"].map((d) => domainRule(d, FOCUS));
    expect(candidateParents(rules).map((c) => c.parent)).toEqual(["bbc.co.uk"]);
  });

  it("refuses a shared host but allows one tenant of it", () => {
    const shared = ["alice.github.io", "bob.github.io", "carol.github.io"].map((d) => domainRule(d, FOCUS));
    expect(candidateParents(shared)).toEqual([]);

    const oneTenant = ["a.foo.github.io", "b.foo.github.io", "c.foo.github.io"].map((d) => domainRule(d, FOCUS));
    expect(candidateParents(oneTenant).map((c) => c.parent)).toEqual(["foo.github.io"]);
  });
});

describe("evidence gates", () => {
  it("needs three rules, not two", () => {
    const two = GOOGLE_CHILDREN.slice(0, 2).map((d) => domainRule(d, FOCUS));
    expect(candidateParents(two)).toEqual([]);

    const three = GOOGLE_CHILDREN.map((d) => domainRule(d, FOCUS));
    expect(candidateParents(three).map((c) => c.parent)).toEqual(["google.com"]);
  });

  it("needs the rules to agree on one category", () => {
    const rules = [
      domainRule("mail.google.com", FOCUS),
      domainRule("docs.google.com", FOCUS),
      domainRule("news.google.com", MEDIA),
    ];
    expect(candidateParents(rules)).toEqual([]);
  });

  it("does not care what the stored priorities are", () => {
    // Priorities are per-database — see `rule_priority_scheme` — and rules
    // migrated from older schemas keep their old numbers. Refusing those would
    // switch the feature off for exactly the long-lived databases it is for.
    // verifyConsolidation catches any priority that changes an outcome.
    const rules = [
      domainRule("mail.google.com", FOCUS, 10),
      domainRule("docs.google.com", FOCUS, 10),
      domainRule("drive.google.com", FOCUS, 10),
    ];
    expect(candidateParents(rules).map((c) => c.parent)).toEqual(["google.com"]);
  });

  it("says nothing when the parent is already written", () => {
    const rules = [
      ...GOOGLE_CHILDREN.map((d) => domainRule(d, FOCUS)),
      domainRule("google.com", FOCUS),
    ];
    expect(candidateParents(rules)).toEqual([]);
  });

  it("does not return a parent that was dismissed", () => {
    const rules = GOOGLE_CHILDREN.map((d) => domainRule(d, FOCUS));
    expect(candidateParents(rules, new Set(["google.com"]))).toEqual([]);
  });

  it("breaks a tie on rule count by name, so the offer is stable across renders", () => {
    const rules = [
      ...GOOGLE_CHILDREN.map((d) => domainRule(d, FOCUS)),
      ...["a.example.net", "b.example.net", "c.example.net"].map((d) => domainRule(d, MEDIA)),
    ];
    expect(candidateParents(rules).map((c) => c.parent)).toEqual(["example.net", "google.com"]);
  });

  it("offers the parent with the most rules first", () => {
    const rules = [
      ...GOOGLE_CHILDREN.map((d) => domainRule(d, FOCUS)),
      ...["a.example.net", "b.example.net", "c.example.net", "d.example.net"].map((d) =>
        domainRule(d, MEDIA)),
    ];
    expect(candidateParents(rules).map((c) => c.parent)).toEqual(["example.net", "google.com"]);
  });
});

describe("the safety invariant", () => {
  it("suggests a consolidation that changes nothing", () => {
    const suggestion = findConsolidation(googleSource());

    expect(suggestion?.parent).toBe("google.com");
    expect(suggestion?.categoryId).toBe(FOCUS);
    expect(suggestion?.childRules).toHaveLength(3);
    expect(suggestion?.absorbedDomains).toEqual([]);
  });

  it("refuses when a session would move between two named categories", () => {
    // A catch-all browser rule already classifies the unruled sibling as
    // Browsing. Consolidating would silently move that time to Focus.
    const source = googleSource([processRule("chrome.exe", BROWSING)], ["photos.google.com"]);
    expect(findConsolidation(source)).toBeNull();
  });

  it("leaves a website-scoped Window rule in charge of its own traffic", () => {
    const source = makeSource(
      [
        ...GOOGLE_CHILDREN.map((domain) => domainRule(domain, FOCUS)),
        windowRuleForDomain("inbox", "mail.google.com", MEDIA),
      ],
      [...trafficFor(GOOGLE_CHILDREN), browsing("mail.google.com", 1800, "inbox zero")],
    );

    const suggestion = findConsolidation(source);
    expect(suggestion?.parent).toBe("google.com");

    // And it still wins after the rewrite, which is why nothing was reported.
    const rewritten = applySuggestion(source, suggestion!);
    const classify = buildClassifier(CATEGORIES, rewritten.rules, new Set(["chrome.exe"]));
    expect(classify(browsing("mail.google.com", 1800, "inbox zero"))?.id).toBe(MEDIA);
  });

  it("preserves every session's category when applied", () => {
    const source = googleSource();
    const suggestion = findConsolidation(source)!;
    const browsers = new Set(["chrome.exe"]);
    const before = buildClassifier(CATEGORIES, source.rules, browsers);
    const after = buildClassifier(CATEGORIES, applySuggestion(source, suggestion).rules, browsers);

    for (const session of source.sessions) {
      expect(after(session)?.id ?? null).toBe(before(session)?.id ?? null);
    }
  });
});

describe("absorbing unruled sites", () => {
  it("names them rather than counting them", () => {
    const source = googleSource([], ["photos.google.com"]);
    const suggestion = findConsolidation(source);

    expect(suggestion?.absorbedDomains).toEqual(["photos.google.com"]);
  });

  it("withholds the suggestion when they outnumber the rules that produced it", () => {
    const source = googleSource([], [
      "photos.google.com",
      "ads.google.com",
      "analytics.google.com",
      "cloud.google.com",
    ]);
    expect(findConsolidation(source)).toBeNull();
  });
});

describe("materiality", () => {
  it("stays quiet about rules covering minutes", () => {
    const source = makeSource(
      GOOGLE_CHILDREN.map((domain) => domainRule(domain, FOCUS)),
      GOOGLE_CHILDREN.map((domain) => browsing(domain, 60)),
    );
    expect(findConsolidation(source)).toBeNull();
  });

  it("reports the time under the parent", () => {
    const suggestion = findConsolidation(googleSource());
    expect(suggestion?.seconds).toBe(GOOGLE_CHILDREN.length * 2 * 1800);
  });
});

describe("verifyConsolidation on its own", () => {
  it("returns null for a candidate whose traffic never happened", () => {
    const rules = GOOGLE_CHILDREN.map((domain) => domainRule(domain, FOCUS));
    const candidate = candidateParents(rules)[0];
    expect(verifyConsolidation(makeSource(rules, []), candidate)).toBeNull();
  });

  it("walks past app sessions, which have no domain and outnumber the rest", () => {
    const source = makeSource(
      GOOGLE_CHILDREN.map((domain) => domainRule(domain, FOCUS)),
      [
        ...trafficFor(GOOGLE_CHILDREN),
        // Unclassified before and after: the parent cannot reach a session that
        // is not in a browser, so neither classifier has an answer for it.
        { ...browsing("mail.google.com"), process: "code.exe", domain: null },
        { ...browsing("docs.google.com"), process: "explorer.exe", domain: null },
      ],
    );
    const suggestion = findConsolidation(source);

    expect(suggestion?.parent).toBe("google.com");
    expect(suggestion?.absorbedDomains).toEqual([]);
    // Only browser time beneath the parent counts toward the floor.
    expect(suggestion?.seconds).toBe(GOOGLE_CHILDREN.length * 2 * 1800);
  });

  it("ignores AFK and zero-length sessions", () => {
    const rules = GOOGLE_CHILDREN.map((domain) => domainRule(domain, FOCUS));
    const afk = { ...browsing("mail.google.com", 99_999), isAfk: true };
    const empty = { ...browsing("docs.google.com", 0) };
    const candidate = candidateParents(rules)[0];
    expect(verifyConsolidation(makeSource(rules, [afk, empty]), candidate)).toBeNull();
  });
});

describe("dismissal storage", () => {
  it("round-trips", () => {
    expect(parseDismissed(serializeDismissed(["b.test", "a.test"]))).toEqual(
      new Set(["a.test", "b.test"]),
    );
  });

  it("treats a missing or corrupt value as nothing dismissed", () => {
    expect(parseDismissed(undefined)).toEqual(new Set());
    expect(parseDismissed("")).toEqual(new Set());
    expect(parseDismissed("not json")).toEqual(new Set());
    expect(parseDismissed('{"parent":"google.com"}')).toEqual(new Set());
    expect(parseDismissed("[1, 2, 3]")).toEqual(new Set());
  });

  it("keeps the strings out of a mixed array", () => {
    expect(parseDismissed('["google.com", 7]')).toEqual(new Set(["google.com"]));
  });
});

/** The rewrite the UI performs: parent in, children out. */
function applySuggestion(
  source: ActivitySource,
  suggestion: { parent: string; categoryId: number; childRules: Rule[] },
): ActivitySource {
  const removed = new Set(suggestion.childRules.map((rule) => rule.id));
  return {
    ...source,
    rules: [
      ...source.rules.filter((rule) => !removed.has(rule.id)),
      {
        id: 9_000,
        matchType: "domain",
        pattern: suggestion.parent,
        categoryId: suggestion.categoryId,
        priority: DEFAULT_RULE_PRIORITY.domain,
      },
    ],
  };
}
