import { describe, expect, it } from "vitest";

import { withAlias } from "./aliases";

describe("shared app alias editing", () => {
  it("saves trimmed names case-insensitively without mutating the current snapshot", () => {
    const current = { "code.exe": "Code" };
    expect(withAlias(current, "CHROME.EXE", "  Browser  ")).toEqual({
      "code.exe": "Code",
      "chrome.exe": "Browser",
    });
    expect(current).toEqual({ "code.exe": "Code" });
  });

  it("removes an alias when the edited name is blank", () => {
    expect(withAlias({ "code.exe": "Editor" }, "Code.exe", "  ")).toEqual({});
  });
});
