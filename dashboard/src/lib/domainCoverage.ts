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

/** Browser time with no split before saying so is worth an interruption.
 *
 *  One minute was enough to prove the mechanism and far too little to earn the
 *  message. It put the hint on screen within a minute of the onboarding screen
 *  where the reader had just answered this exact question, which reads as the
 *  app not having heard the answer. Half an hour of unsplit browsing is where
 *  the absent split is costing them something they can see. */
export const DOMAIN_HINT_MIN_BROWSER_SECONDS = 1_800;

/** Browser time before the *positive* signal means anything. Deliberately far
 *  lower than the hint: confirming data is arriving interrupts nobody. */
export const WEBSITE_SIGNAL_MIN_BROWSER_SECONDS = 60;

/** Above this share of browser time carrying no domain, treat the split as
 *  absent rather than partial. */
const MOSTLY_MISSING = 0.9;

export function shouldShowDomainCoverageHint(coverage: BrowserDomainCoverage): boolean {
  return (
    coverage.totalSeconds >= DOMAIN_HINT_MIN_BROWSER_SECONDS
    && coverage.missingFraction > MOSTLY_MISSING
  );
}

/**
 * Websites are reaching Time.
 *
 * There is no way to ask Windows whether a browser extension is installed, and
 * a message that guessed would be worse than none. This asks the only question
 * that matters anyway — is the data arriving — which is also the question the
 * reader has.
 *
 * Stated as its own condition on the *evidence*, not as "the hint is not
 * showing". Those were once equivalent and stopped being so the moment the two
 * thresholds diverged: between one minute and half an hour with no domains at
 * all, negating the hint would have reported that website tracking works
 * precisely because too little time had passed to complain that it does not.
 *
 * Note the lag this implies: the tracker sees a domain only once a browser
 * window with a page open has been in the foreground. Confirmation can trail an
 * install by minutes, which is why anything built on this should confirm the
 * data ("website tracking is working") and never the install ("extension
 * installed") — the latter reads as broken during the gap.
 */
export function websiteSignalConfirmed(coverage: BrowserDomainCoverage): boolean {
  return (
    coverage.totalSeconds >= WEBSITE_SIGNAL_MIN_BROWSER_SECONDS
    && coverage.missingFraction <= MOSTLY_MISSING
  );
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
  // Gated on the positive signal rather than on the absence of the hint above.
  // Suggesting a website rule only makes sense once websites are actually being
  // recorded, and while the thresholds differ "no hint yet" no longer implies
  // that — it would have advised writing a rule for sites Time cannot see.
  if (!websiteSignalConfirmed(coverage)) return false;
  return browserClassified && !hasWebsiteRule;
}
