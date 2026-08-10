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
