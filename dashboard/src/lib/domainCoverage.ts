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
