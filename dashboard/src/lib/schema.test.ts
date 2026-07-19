import { describe, expect, it } from "vitest";

import {
  SUPPORTED_SCHEMA_VERSION,
  assertSupportedSchemaVersion,
  isNewerSchemaError,
} from "./schema";

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
    expect(message).toContain("dashboard supports 1");
  });

  it("rejects malformed versions", () => {
    expect(() => assertSupportedSchemaVersion("1.5")).toThrow("schema version is invalid");
  });
});
