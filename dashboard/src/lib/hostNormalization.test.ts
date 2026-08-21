import { describe, expect, it } from "vitest";

import fixture from "../../../contracts/host_normalization.json";
import { normalizeHost } from "./hostNormalization";

describe("normalizeHost shared fixture", () => {
  it.each(fixture.cases)("normalizes $input", (testCase) => {
    expect(normalizeHost(testCase.input)).toBe(testCase.expected);
  });
});
