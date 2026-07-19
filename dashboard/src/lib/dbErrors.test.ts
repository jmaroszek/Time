import { describe, expect, it } from "vitest";

import { explainDbError, isMissingSchemaError } from "./dbErrors";

describe("explainDbError", () => {
  it("names duplicate categories specifically", () => {
    const raw = "error returned from database: (code: 2067) UNIQUE constraint failed: categories.name";
    expect(explainDbError(raw)).toBe("A category with that name already exists.");
  });

  it("maps other UNIQUE violations to the subject", () => {
    const raw = "UNIQUE constraint failed: rules.pattern";
    expect(explainDbError(raw, "rule")).toBe("That rule already exists.");
  });

  it("maps a locked database to a retry hint", () => {
    expect(explainDbError("database is locked")).toBe(
      "The database is busy — try again in a moment.",
    );
  });

  it("maps a missing schema to a tracker hint", () => {
    expect(explainDbError("no such table: categories")).toContain("tracker");
  });

  it("falls back to the raw cause, stripped of plugin noise", () => {
    expect(explainDbError("error returned from database: something odd", "rule")).toBe(
      "Couldn't save the rule: something odd",
    );
  });

  it("passes ValidationError messages through untouched", () => {
    const err = new Error("\"https://\" doesn't contain a usable domain — enter one like example.com.");
    err.name = "ValidationError";
    expect(explainDbError(err, "rule")).toBe(err.message);
  });

  it("accepts Error objects as well as strings", () => {
    expect(explainDbError(new Error("database is locked"))).toBe(
      "The database is busy — try again in a moment.",
    );
  });
});

describe("isMissingSchemaError", () => {
  it("detects the empty-DB bootstrap failure", () => {
    expect(isMissingSchemaError("no such table: categories")).toBe(true);
    expect(isMissingSchemaError("UNIQUE constraint failed")).toBe(false);
  });
});
