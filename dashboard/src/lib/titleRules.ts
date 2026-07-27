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
const VERSION = /(?:^|[^\p{L}\p{N}])v?\d+\.\d+(?:\.\d+){0,2}(?:[^\p{L}\p{N}]|$)/iu;

/** Remove decorations Windows and common Windows apps add around a title. */
export function normalizeWindowTitle(raw: string): string {
  let title = raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim();
  // Apply twice because elevated consoles can also carry an unread-count or
  // unsaved marker. Each expression is edge-anchored: punctuation in the
  // actual document/project name remains untouched.
  for (let pass = 0; pass < 2; pass += 1) {
    title = title
      .replace(/^(?:administrator|admin)\s*:\s*/iu, "")
      .replace(/^\(\d+\)\s*/u, "")
      .replace(/^[●•]\s*/u, "")
      .replace(/^\*\s*(?=\S)/u, "")
      .replace(/\s*[●•*]\s*$/u, "")
      .trim();
  }
  return title.replace(/\s+/g, " ").toLowerCase();
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

function containsTokenPhrase(title: string, pattern: string): boolean {
  const haystack = titleTokens(title);
  const needle = titleTokens(pattern);
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
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

/** Match a fully normalized Window rule against one foreground session. */
export function titleRuleMatches(
  rawSpec: TitleRuleSpec,
  context: TitleMatchContext,
  browserProcesses: Set<string>,
): boolean {
  const spec = normalizeTitleRuleSpec(rawSpec);
  if (!spec.pattern || !context.title) return false;
  if (!titleScopeAdmits(spec, context, browserProcesses)) return false;
  return titlePatternMatches(spec, context.title);
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
