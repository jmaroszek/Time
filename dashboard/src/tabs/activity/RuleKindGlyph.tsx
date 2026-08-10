import type { MatchType } from "../../lib/classify";

/** Rule kinds use shape rather than hue; color already means category identity. */
export default function RuleKindGlyph({ matchType }: { matchType: MatchType }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {matchType === "process" && <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v4M8 21h8" /></>}
      {matchType === "title" && <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></>}
      {matchType === "domain" && <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 3.6 9 14 14 0 0 1-3.6 9 14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z" /></>}
    </svg>
  );
}
