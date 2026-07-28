import { describe, expect, it } from "vitest";

// ?raw rather than node:fs: this project's tsconfig carries no Node types, and
// Vite resolves these at build time so a moved file breaks the import loudly
// instead of silently reading nothing.
import pythonSource from "../../../tracker/db.py?raw";
import rustSource from "../../src-tauri/src/database.rs?raw";
import { DEFAULT_USER_SETTINGS } from "./queries";
import {
  SUPPORTED_SCHEMA_VERSION,
  assertSupportedSchemaVersion,
  isNewerSchemaError,
} from "./schema";

/**
 * The schema version is declared in four places and only one of them migrates.
 * A missed copy compiles, passes every other test, and then refuses a database
 * the tracker has already upgraded — on the user's machine, after the upgrade
 * is irreversible without a backup. So the copies are compared directly.
 */
describe("schema version declarations agree", () => {
  it("matches the tracker, which is the half that migrates", () => {
    const match = /^SCHEMA_VERSION = (\d+)$/m.exec(pythonSource);
    expect(match?.[1]).toBe(String(SUPPORTED_SCHEMA_VERSION));
  });

  it("matches the Rust constant and the version it bootstraps", () => {
    const constant = /^(?:pub\(crate\) )?const SCHEMA_VERSION: i64 = (\d+);$/m.exec(rustSource);
    expect(constant?.[1]).toBe(String(SUPPORTED_SCHEMA_VERSION));
    expect(rustSource).toContain(`('schema_version','${SUPPORTED_SCHEMA_VERSION}')`);
  });
});

/**
 * Fresh-install setting values live in three places for the same reason the
 * schema does: either half may create the database. A drifted default is
 * invisible — the app runs, and only a brand-new install behaves differently
 * from the one the developer is looking at.
 */
describe("default settings agree across both halves", () => {
  // Values may be a single literal or several concatenated across lines, as
  // browser_processes is — so collect every fragment and join them the way
  // Python does, rather than reading only the first.
  const pythonDefault = (key: string) => {
    const entry = new RegExp(`"${key}":\\s*(\\([\\s\\S]*?\\)|"[^"]*")\\s*,`).exec(pythonSource);
    const fragments = entry?.[1].match(/"[^"]*"/g);
    return fragments?.map((fragment) => fragment.slice(1, -1)).join("");
  };

  it("matches tracker/db.py DEFAULT_SETTINGS", () => {
    const drifted: string[] = [];
    for (const [key, value] of Object.entries(DEFAULT_USER_SETTINGS)) {
      const python = pythonDefault(key);
      // Only keys the tracker also seeds; the TS map deliberately omits some.
      if (python !== undefined && python !== value) drifted.push(`${key}: py=${python} ts=${value}`);
    }
    expect(drifted).toEqual([]);
  });

  it("matches the Rust BOOTSTRAP_SQL seed", () => {
    const drifted: string[] = [];
    for (const [key, value] of Object.entries(DEFAULT_USER_SETTINGS)) {
      const match = new RegExp(`\\('${key}','([^']*)'\\)`).exec(rustSource);
      if (match && match[1] !== value) drifted.push(`${key}: rs=${match[1]} ts=${value}`);
    }
    expect(drifted).toEqual([]);
  });
});

describe("schema compatibility", () => {
  it("allows the legacy unversioned schema", () => {
    expect(assertSupportedSchemaVersion(undefined)).toBeNull();
  });

  it("allows the current schema", () => {
    expect(assertSupportedSchemaVersion(String(SUPPORTED_SCHEMA_VERSION))).toBe(
      SUPPORTED_SCHEMA_VERSION,
    );
  });

  it("identifies and refuses a newer schema", () => {
    let message = "";
    try {
      assertSupportedSchemaVersion(String(SUPPORTED_SCHEMA_VERSION + 1));
    } catch (error) {
      message = String(error);
    }
    expect(isNewerSchemaError(message)).toBe(true);
    expect(message).toContain(`dashboard supports ${SUPPORTED_SCHEMA_VERSION}`);
  });

  it("rejects malformed versions", () => {
    expect(() => assertSupportedSchemaVersion("1.5")).toThrow("schema version is invalid");
  });
});
