import { duration, type Session } from "./metrics";

export interface BrowserDomainCoverage {
  totalSeconds: number;
  missingSeconds: number;
  missingFraction: number;
}

/** Coverage for non-AFK browser time in an already-clipped session range. */
export function browserDomainCoverage(
  sessions: Session[],
  browserProcesses: ReadonlySet<string>,
): BrowserDomainCoverage {
  let totalSeconds = 0;
  let missingSeconds = 0;
  for (const session of sessions) {
    if (session.isAfk || !browserProcesses.has(session.process)) continue;
    const seconds = duration(session);
    totalSeconds += seconds;
    if (!session.domain) missingSeconds += seconds;
  }
  return {
    totalSeconds,
    missingSeconds,
    missingFraction: totalSeconds === 0 ? 0 : missingSeconds / totalSeconds,
  };
}

/** Avoid transient/new-tab noise; one minute is enough to help a new user. */
export function shouldShowDomainCoverageHint(coverage: BrowserDomainCoverage): boolean {
  return coverage.totalSeconds >= 60 && coverage.missingFraction > 0.9;
}

/**
 * Websites are reaching Time.
 *
 * There is no way to ask Windows whether a browser extension is installed, and
 * a message that guessed would be worse than none. This asks the only question
 * that matters anyway — is the data arriving — which is also the question the
 * reader has. It is the exact complement of `shouldShowDomainCoverageHint`
 * above the same minute of browser time, so the two can never both be true.
 *
 * Note the lag this implies: the tracker sees a domain only once a browser
 * window with a page open has been in the foreground. Confirmation can trail an
 * install by minutes, which is why anything built on this should confirm the
 * data ("website tracking is working") and never the install ("extension
 * installed") — the latter reads as broken during the gap.
 */
export function websiteSignalConfirmed(coverage: BrowserDomainCoverage): boolean {
  return coverage.totalSeconds >= 60 && !shouldShowDomainCoverageHint(coverage);
}

/**
 * The complement of `shouldShowDomainCoverageHint`: websites *are* being
 * recorded, and the reader has classified their browser without ever writing a
 * rule for a site inside it.
 *
 * That combination is where a correct action leads to a wrong conclusion. Once
 * chrome.exe is Browsing, every site inside it inherits that category and the
 * app row looks finished, so nothing on screen suggests the sites could be
 * separated.
 *
 * `hasWebsiteRule` — not "are any websites still unclassified". The first
 * version of this asked the latter and could never fire: classifying the
 * browser is precisely what stops those websites counting as unclassified, so
 * the condition erased itself at the moment it became true. What actually
 * distinguishes the misled reader is that they have never written a website
 * rule at all. One is enough to prove they found the idea, and the hint retires
 * for good.
 */
export function shouldShowWebsiteRuleHint(
  coverage: BrowserDomainCoverage,
  browserClassified: boolean,
  hasWebsiteRule: boolean,
): boolean {
  if (shouldShowDomainCoverageHint(coverage)) return false;
  return coverage.totalSeconds >= 60 && browserClassified && !hasWebsiteRule;
}
