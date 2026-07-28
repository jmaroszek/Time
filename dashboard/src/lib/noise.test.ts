import { describe, expect, it } from "vitest";

import {
  classifyNoise,
  hidesRareItems,
  hidesUtilities,
  isUtilityName,
  noiseModeFor,
  noisePolicyFromSettings,
  DEFAULT_NOISE_POLICY,
  type NoiseCandidate,
  type NoisePolicy,
} from "./noise";

function entity(overrides: Partial<NoiseCandidate>): NoiseCandidate {
  return {
    kind: "app",
    key: "thing.exe",
    sourceProcesses: [],
    seconds: 10,
    sessionCount: 1,
    status: "uncategorized",
    ...overrides,
  };
}

const policy: NoisePolicy = { mode: "utilities", maxSeconds: 120, maxSessions: 3 };

describe("noise filtering", () => {
  it("needs both halves of the rare-item test", () => {
    // Brief and rare: noise.
    expect(classifyNoise(entity({ seconds: 25, sessionCount: 1 }), policy)).toBe("one_off");
    expect(classifyNoise(entity({ seconds: 110, sessionCount: 3 }), policy)).toBe("one_off");
    // Brief but constant — a habit, not noise.
    expect(classifyNoise(entity({ seconds: 100, sessionCount: 40 }), policy)).toBeNull();
    // Rare but substantial — real work in one sitting.
    expect(classifyNoise(entity({ seconds: 2400, sessionCount: 1 }), policy)).toBeNull();
  });

  it("keeps anything the user has classified", () => {
    for (const status of ["single", "partial", "mixed", "ignored"] as const) {
      expect(classifyNoise(entity({ seconds: 3, sessionCount: 1, status }), policy)).toBeNull();
    }
  });

  it("hides installers and drivers regardless of how long they ran", () => {
    const long = { seconds: 3600, sessionCount: 5 };
    for (const key of [
      "googledrivesetup.exe",
      "amdsoftwareinstaller.exe",
      "antigravity.tmp",
      "amd_chipset_software_8.02.18.557.exe",
      "asrruefisetup(v1.0.15).tmp",
      "antigravitysetup-stable-b2e8a8c5f9322b9bdc2bed64853db1.exe",
      "msiexec.exe",
    ]) {
      expect(classifyNoise(entity({ ...long, key }), policy), key).toBe("utility");
    }
  });

  it("leaves real applications alone", () => {
    const long = { seconds: 3600, sessionCount: 5 };
    for (const key of ["code.exe", "chrome.exe", "steam.exe", "photoshop.exe", "explorer.exe"]) {
      expect(classifyNoise(entity({ ...long, key }), policy), key).toBeNull();
    }
  });

  it("treats browser-rendered local files as utilities but spares code-ish domains", () => {
    const website = { kind: "website" as const, seconds: 3600, sessionCount: 5 };
    expect(classifyNoise(entity({ ...website, key: "3445-4315-aad9-e0df83a75222-91828787.pdf" }), policy)).toBe("utility");
    expect(classifyNoise(entity({ ...website, key: "cytoscape.js" }), policy)).toBeNull();
    expect(classifyNoise(entity({ ...website, key: "en.wikipedia.org" }), policy)).toBeNull();
  });

  it("drops the utility test in one_off mode and hides nothing when off", () => {
    const installer = entity({ key: "googledrivesetup.exe", seconds: 3600, sessionCount: 5 });
    expect(classifyNoise(installer, { ...policy, mode: "one_off" })).toBeNull();
    expect(classifyNoise(entity({ seconds: 3, sessionCount: 1 }), { ...policy, mode: "off" })).toBeNull();
  });

  it("supports utilities without hiding rare applications", () => {
    const utilitiesOnly = { ...policy, mode: "utilities_only" as const };
    expect(
      classifyNoise(
        entity({ key: "googledrivesetup.exe", seconds: 3600, sessionCount: 5 }),
        utilitiesOnly,
      ),
    ).toBe("utility");
    expect(classifyNoise(entity({ seconds: 3, sessionCount: 1 }), utilitiesOnly)).toBeNull();
  });

  it("maps the independent switches onto all four stored modes", () => {
    expect(noiseModeFor(false, false)).toBe("off");
    expect(noiseModeFor(true, false)).toBe("one_off");
    expect(noiseModeFor(false, true)).toBe("utilities_only");
    expect(noiseModeFor(true, true)).toBe("utilities");
    expect(hidesRareItems("utilities")).toBe(true);
    expect(hidesUtilities("utilities_only")).toBe(true);
  });

  it("matches utility names on aliased entities through their source processes", () => {
    expect(isUtilityName(entity({ key: "codex installer", sourceProcesses: [] }))).toBe(true);
    expect(isUtilityName(entity({ key: "app", sourceProcesses: ["Vendor_Driver_Bundle.exe"] }))).toBe(true);
  });

  it("falls back per-field on missing or unparseable settings", () => {
    expect(noisePolicyFromSettings({})).toEqual(DEFAULT_NOISE_POLICY);
    expect(DEFAULT_NOISE_POLICY.maxSessions).toBe(1);
    expect(noisePolicyFromSettings({ activity_noise_filter: "nonsense" }).mode).toBe("utilities");
    expect(noisePolicyFromSettings({ activity_noise_max_seconds: "-5" }).maxSeconds).toBe(120);
    expect(
      noisePolicyFromSettings({
        activity_noise_filter: "utilities_only",
        activity_noise_max_seconds: "300",
        activity_noise_max_sessions: "5",
      }),
    ).toEqual({ mode: "utilities_only", maxSeconds: 300, maxSessions: 5 });
  });
});
