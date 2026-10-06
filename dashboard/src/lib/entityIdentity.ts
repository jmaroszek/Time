import { appGroupKey, cleanDomainName, cleanProcessName } from "./format";
import type { Session } from "./metrics";

export type EntityIdentityKind = "app" | "website";

/** Stable identity shared by Activity indexing, rule analysis, and dismissals. */
export function entityId(kind: EntityIdentityKind, key: string): string {
  return `${kind}:${key.toLowerCase()}`;
}

export function entityIdentity(
  session: Pick<Session, "process" | "domain">,
  browserProcesses: ReadonlySet<string>,
): { id: string; kind: EntityIdentityKind; key: string } {
  const process = session.process.toLowerCase();
  if (browserProcesses.has(process) && session.domain) {
    const key = session.domain.toLowerCase();
    return { id: entityId("website", key), kind: "website", key };
  }
  return { id: entityId("app", process), kind: "app", key: process };
}

/** NUL cannot occur in either half of a window key — normalization strips
 *  controls — so no pair of different (entity, title) values can collide on the
 *  joined string. Written as an escape because a literal NUL in source is
 *  invisible and makes the file read as binary. */
const WINDOW_KEY_SEP = "\u0000";

/** Activity's key for one window: its entity plus its normalized title. Entity
 *  as well as title, because "Inbox" in a browser and "Inbox" in a mail client
 *  are different activities that happen to share a word. Insights builds the
 *  same key to open a window it lists in Activity. */
export function windowGroupKey(entity: string, normalizedTitle: string): string {
  return `${entity}${WINDOW_KEY_SEP}${normalizedTitle}`;
}

/**
 * The row a session lands in when Insights breaks time down by what it was
 * spent in: a website when a browser recorded one, otherwise an app, grouped by
 * display name the way the Top Apps list groups it.
 *
 * Unlike the Top Apps list, a browser's website time is its website's here and
 * not the browser's: a breakdown that put YouTube under "Google Chrome" would
 * be answering a question about software instead of about attention.
 */
export function insightsMember(
  session: Pick<Session, "process" | "domain">,
  aliases: Record<string, string>,
  browserProcesses: ReadonlySet<string>,
): { key: string; kind: EntityIdentityKind; name: string } {
  if (session.domain && browserProcesses.has(session.process.toLowerCase())) {
    const domain = session.domain.toLowerCase();
    return { key: `site:${domain}`, kind: "website", name: cleanDomainName(domain, aliases) };
  }
  return {
    key: `app:${appGroupKey(session.process, aliases)}`,
    kind: "app",
    name: cleanProcessName(session.process, aliases),
  };
}
