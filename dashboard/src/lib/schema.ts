/** Schema compatibility boundary shared with tracker/db.py. */

export const SUPPORTED_SCHEMA_VERSION = 1;
const NEWER_SCHEMA_PREFIX = "DatabaseSchemaTooNew:";

/** Missing means the pre-versioning legacy schema, which remains readable. */
export function assertSupportedSchemaVersion(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new Error("The database schema version is invalid.");
  const version = Number(raw);
  if (!Number.isSafeInteger(version)) throw new Error("The database schema version is invalid.");
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `${NEWER_SCHEMA_PREFIX} database schema ${version}; dashboard supports` +
        ` ${SUPPORTED_SCHEMA_VERSION}`,
    );
  }
  return version;
}

export function isNewerSchemaError(error: string): boolean {
  return error.includes(NEWER_SCHEMA_PREFIX);
}
