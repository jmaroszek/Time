/** Windows title cleanup shared by matching and rule suggestions.
 *
 * Window text is volatile even when the thing it identifies is stable:
 * notification counts, elevated-process prefixes, unsaved markers, spacing,
 * and Unicode separator variants all change without changing user intent.
 * Rules compare the cleaned form so those decorations never become identity.
 */

export type TitleRuleScopeKind = "any" | "browsers" | "process" | "domain";
export type TitleRuleMatchMode = "segment" | "phrase" | "contains";
export type TitleRuleAnchor = "any" | "first" | "interior" | "last";

export interface TitleRuleSpec {
  pattern: string;
  scopeKind: TitleRuleScopeKind;
  scopeValue: string;
  titleMatchMode: TitleRuleMatchMode;
  titleAnchor: TitleRuleAnchor;
}

export interface TitleMatchContext {
  process: string;
  title: string;
  domain: string | null;
}

export const ANY_APP: TitleRuleScopeKind = "any";
export const BROWSER_SCOPE: TitleRuleScopeKind = "browsers";

const TITLE_SEPARATOR = /\s+[-–—|·•]\s+/u;
const WORD = /[\p{L}\p{N}]+/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const VERSION = /(?:^|[^\p{L}\p{N}])v?\d+\.\d+(?:\.\d+){0,2}(?:[^\p{L}\p{N}]|$)/iu;

/**
 * Each stage of the pipeline below is skipped when a scan proves it cannot
 * change the string.
 *
 * Normalization is the whole cost of Window-rule matching and it runs over
 * every session in the database, but on an ordinary title every one of its
 * expressions is a no-op, and scanning for the few characters that could make
 * one fire is far cheaper than running it. Each scan reads the value at its own
 * point in the pipeline rather than the original, because an earlier stage can
 * create work for a later one: NFKC turns a fullwidth marker into an ASCII one,
 * and replacing a control character introduces a space.
 */
function hasCodeOutside(title: string, lowest: number, highest: number): boolean {
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    if (code < lowest || code > highest) return true;
  }
  return false;
}

/** Every code point JavaScript's \s matches. Listed rather than conceded to,
 *  because an em dash or a non-breaking space puts an otherwise ordinary title
 *  above ASCII and the collapse below is the most expensive stage left. */
function isSpaceLike(code: number): boolean {
  return (
    code === 0x20
    || (code >= 0x09 && code <= 0x0d)
    || code === 0xa0
    || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028
    || code === 0x2029
    || code === 0x202f
    || code === 0x205f
    || code === 0x3000
    || code === 0xfeff
  );
}

/** Whitespace that trim or the collapse would rewrite: an edge space, two in a
 *  row, or any whitespace character that is not already a plain space. */
function hasRewritableSpace(title: string): boolean {
  const length = title.length;
  if (length === 0) return false;
  if (isSpaceLike(title.charCodeAt(0)) || isSpaceLike(title.charCodeAt(length - 1))) return true;
  for (let index = 0; index < length; index += 1) {
    const code = title.charCodeAt(index);
    if (!isSpaceLike(code)) continue;
    if (code !== 0x20 || isSpaceLike(title.charCodeAt(index + 1))) return true;
  }
  return false;
}

/** Whether either end could start or close one of the decoration expressions.
 *  All five are edge-anchored, so the two ends decide for the whole string. */
function hasEdgeDecoration(title: string): boolean {
  const length = title.length;
  if (length === 0) return false;
  const first = title.charCodeAt(0);
  // "a"/"A" open administrator:, "(" an unread count, "*" an unsaved marker,
  // and each bullet form is its own prefix.
  if (
    first === 0x61 || first === 0x41 || first === 0x28 || first === 0x2a
    || first === 0x25cf || first === 0x2022
  ) return true;
  const last = title.charCodeAt(length - 1);
  return last === 0x2a || last === 0x25cf || last === 0x2022;
}

function hasUpperCase(title: string): boolean {
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index);
    // Above ASCII, deciding case properly is the lowercaser's job.
    if ((code >= 0x41 && code <= 0x5a) || code > 0x7e) return true;
  }
  return false;
}

/** Remove decorations Windows and common Windows apps add around a title. */
export function normalizeWindowTitle(raw: string): string {
  // NFKC never alters an ASCII code point, so a pure-ASCII title can skip it.
  let title = hasCodeOutside(raw, 0x00, 0x7f) ? raw.normalize("NFKC") : raw;
  if (hasCodeOutside(title, 0x20, 0x7e)) title = title.replace(CONTROL_CHARACTERS, " ");
  title = title.trim();
  // Apply twice because elevated consoles can also carry an unread-count or
  // unsaved marker. Each expression is edge-anchored: punctuation in the
  // actual document/project name remains untouched.
  if (hasEdgeDecoration(title)) {
    for (let pass = 0; pass < 2; pass += 1) {
      title = title
        .replace(/^(?:administrator|admin)\s*:\s*/iu, "")
        .replace(/^\(\d+\)\s*/u, "")
        .replace(/^[●•]\s*/u, "")
        .replace(/^\*\s*(?=\S)/u, "")
        .replace(/\s*[●•*]\s*$/u, "")
        .trim();
    }
  }
  if (hasRewritableSpace(title)) title = title.replace(/\s+/g, " ");
  return hasUpperCase(title) ? title.toLowerCase() : title;
}

/** Split only visible separator runs, never a hyphen inside a word. */
export function splitWindowTitle(raw: string): string[] {
  const title = normalizeWindowTitle(raw);
  return title ? title.split(TITLE_SEPARATOR).map((part) => part.trim()).filter(Boolean) : [];
}

export function titleTokens(raw: string): string[] {
  return normalizeWindowTitle(raw).match(WORD) ?? [];
}

export function containsVersion(raw: string): boolean {
  return VERSION.test(normalizeWindowTitle(raw));
}

export function normalizeTitleRuleSpec(spec: TitleRuleSpec): TitleRuleSpec {
  const scopeKind = spec.scopeKind;
  const scopeValue = scopeKind === "process"
    ? spec.scopeValue.trim().toLowerCase()
    : scopeKind === "domain"
      ? spec.scopeValue.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
      : "";
  return {
    pattern: normalizeWindowTitle(spec.pattern),
    scopeKind,
    scopeValue,
    titleMatchMode: spec.titleMatchMode,
    titleAnchor: spec.titleMatchMode === "segment" ? spec.titleAnchor : "any",
  };
}

export function titleScopeAdmits(
  spec: Pick<TitleRuleSpec, "scopeKind" | "scopeValue">,
  context: Pick<TitleMatchContext, "process" | "domain">,
  browserProcesses: Set<string>,
): boolean {
  const process = context.process.toLowerCase();
  switch (spec.scopeKind) {
    case "any":
      return true;
    case "browsers":
      return browserProcesses.has(process);
    case "process":
      return process === spec.scopeValue;
    case "domain": {
      if (!browserProcesses.has(process) || !context.domain) return false;
      const domain = context.domain.toLowerCase();
      return domain === spec.scopeValue || domain.endsWith(`.${spec.scopeValue}`);
    }
  }
}

function anchorAdmits(index: number, count: number, anchor: TitleRuleAnchor): boolean {
  if (anchor === "any") return true;
  if (anchor === "first") return index === 0;
  if (anchor === "last") return index === count - 1;
  return index > 0 && index < count - 1;
}

function tokenPhraseIn(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function containsTokenPhrase(title: string, pattern: string): boolean {
  return tokenPhraseIn(titleTokens(title), titleTokens(pattern));
}

export function titlePatternMatches(
  rawSpec: Pick<TitleRuleSpec, "pattern" | "titleMatchMode" | "titleAnchor">,
  title: string,
): boolean {
  const pattern = normalizeWindowTitle(rawSpec.pattern);
  if (!pattern || !title) return false;
  if (rawSpec.titleMatchMode === "contains") {
    return normalizeWindowTitle(title).includes(pattern);
  }
  if (rawSpec.titleMatchMode === "phrase") {
    return containsTokenPhrase(title, pattern);
  }
  const segments = splitWindowTitle(title);
  return segments.some(
    (segment, index) =>
      segment === pattern && anchorAdmits(index, segments.length, rawSpec.titleAnchor),
  );
}

/**
 * One session's title, normalized at most once and split or tokenized on
 * demand.
 *
 * Matching a session used to normalize its title once per Window rule, because
 * every entry point into the matcher took a raw string. That made each rule its
 * own pass over the whole database rather than a lookup against work already
 * done. The derived forms are lazy because a rule whose scope rejects the
 * session never looks at the title at all.
 */
export class SessionTitle {
  private normalizedTitle: string | null = null;
  private segmentList: string[] | null = null;
  private tokenList: string[] | null = null;

  constructor(private readonly raw: string) {}

  normalized(): string {
    if (this.normalizedTitle === null) this.normalizedTitle = normalizeWindowTitle(this.raw);
    return this.normalizedTitle;
  }

  segments(): string[] {
    if (this.segmentList === null) {
      const title = this.normalized();
      this.segmentList = title
        ? title.split(TITLE_SEPARATOR).map((part) => part.trim()).filter(Boolean)
        : [];
    }
    return this.segmentList;
  }

  tokens(): string[] {
    if (this.tokenList === null) this.tokenList = this.normalized().match(WORD) ?? [];
    return this.tokenList;
  }
}

/** A Window rule normalized once, carrying the token form phrase mode needs. */
export interface PreparedTitleRule extends TitleRuleSpec {
  patternTokens: string[];
}

/** Do a rule's share of the matching work once rather than once per session. */
export function prepareTitleRule(spec: TitleRuleSpec): PreparedTitleRule {
  const normalized = normalizeTitleRuleSpec(spec);
  return { ...normalized, patternTokens: normalized.pattern.match(WORD) ?? [] };
}

/** The decision `titleRuleMatches` makes, with both sides already normalized. */
export function preparedTitleRuleMatches(
  spec: PreparedTitleRule,
  context: Pick<TitleMatchContext, "process" | "domain">,
  title: SessionTitle,
  browserProcesses: Set<string>,
): boolean {
  if (!spec.pattern) return false;
  // Scope first: it is a set lookup or a string compare, and rejecting here is
  // what keeps a narrowly scoped rule from normalizing every title in the
  // database only to find it was never eligible for any of them.
  if (!titleScopeAdmits(spec, context, browserProcesses)) return false;
  const normalized = title.normalized();
  if (!normalized) return false;
  if (spec.titleMatchMode === "contains") return normalized.includes(spec.pattern);
  if (spec.titleMatchMode === "phrase") return tokenPhraseIn(title.tokens(), spec.patternTokens);
  const segments = title.segments();
  return segments.some(
    (segment, index) =>
      segment === spec.pattern && anchorAdmits(index, segments.length, spec.titleAnchor),
  );
}

/** Match a fully normalized Window rule against one foreground session. */
export function titleRuleMatches(
  rawSpec: TitleRuleSpec,
  context: TitleMatchContext,
  browserProcesses: Set<string>,
): boolean {
  if (!context.title) return false;
  return preparedTitleRuleMatches(
    prepareTitleRule(rawSpec),
    context,
    new SessionTitle(context.title),
    browserProcesses,
  );
}

export function titleScopeSpecificity(scopeKind: TitleRuleScopeKind): number {
  switch (scopeKind) {
    case "domain": return 4;
    case "process": return 3;
    case "browsers": return 2;
    case "any": return 1;
  }
}

export function titleMatchSpecificity(
  mode: TitleRuleMatchMode,
  anchor: TitleRuleAnchor,
): number {
  if (mode === "segment") return anchor === "any" ? 3 : 4;
  if (mode === "phrase") return 2;
  return 1;
}
