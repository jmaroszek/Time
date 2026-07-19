// Map raw SQLite/plugin error strings to one-line human causes. Every
// user-initiated write routes its failure through here: the goal is
// that "saved" and "silently failed" are never indistinguishable.

/** True when the error is the empty-DB case: the tracker has not yet created
 *  the schema, which happens when the dashboard is opened first. */
export function isMissingSchemaError(e: unknown): boolean {
  return /no such table/i.test(String(e));
}

/** One human-readable sentence for a failed DB write. `subject` names the
 *  thing being saved ("category", "rule", "setting") for the generic cases. */
export function explainDbError(e: unknown, subject = "change"): string {
  if (e instanceof Error && e.name === "ValidationError") return e.message;
  const raw = String(e);
  const unique = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(raw);
  if (unique) {
    const [, table] = unique;
    if (table === "categories") return "A category with that name already exists.";
    return `That ${subject} already exists.`;
  }
  if (/database is locked|database table is locked/i.test(raw)) {
    return "The database is busy — try again in a moment.";
  }
  if (isMissingSchemaError(e)) {
    return "The database hasn't been set up yet — make sure the tracker is running.";
  }
  if (/disk|readonly|read-only/i.test(raw)) {
    return `Couldn't write the ${subject} — the database file may be read-only or the disk full.`;
  }
  return `Couldn't save the ${subject}: ${raw.replace(/^error returned from database:\s*/i, "")}`;
}
