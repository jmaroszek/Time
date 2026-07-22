/** Return the persisted alias map for one identity without mutating the
 * caller's snapshot. Both Insights and Activity use the same blank-removes,
 * case-insensitive behavior. */
export function withAlias(
  aliases: Record<string, string>,
  identity: string,
  requested: string,
): Record<string, string> {
  const next = { ...aliases };
  const key = identity.toLowerCase();
  const alias = requested.trim();
  if (alias) next[key] = alias;
  else delete next[key];
  return next;
}
