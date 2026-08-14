import { describe, expect, it } from "vitest";

import { defaultBackupName } from "./backupName";

describe("defaultBackupName", () => {
  it("uses a zero-padded local numeric date that is safe in a filename", () => {
    expect(defaultBackupName(new Date(2026, 7, 13))).toBe("Backup 08-13-2026");
  });
});
