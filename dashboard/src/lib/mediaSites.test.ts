import { describe, expect, it } from "vitest";

// ?raw for the same reason schema.test.ts uses it: the tracker is the half that
// actually gates AFK, so the check has to read its source rather than a second
// hand-maintained copy of it.
import pythonSource from "../../../tracker/media_playback.py?raw";
import {
  BUILT_IN_MEDIA_SITES,
  coveringMediaSite,
  normalizeMediaSite,
  normalizeMediaSites,
} from "./mediaSites";

/**
 * The dashboard's copy of the built-in list exists only to tell the reader that
 * an entry is redundant. A drifted copy is invisible in the worst direction:
 * the field would accept a site Time already covers, or claim to recognize one
 * it does not, and either way tracking behaves differently from what the
 * settings panel just said.
 */
describe("built-in media sites agree with the tracker", () => {
  it("matches _MEDIA_DOMAINS in tracker/media_playback.py", () => {
    const block = /_MEDIA_DOMAINS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/.exec(pythonSource);
    const python = [...(block?.[1].match(/"[^"]*"/g) ?? [])].map((entry) =>
      entry.slice(1, -1),
    );
    expect(python.length).toBeGreaterThan(0);
    expect([...BUILT_IN_MEDIA_SITES].sort()).toEqual(python.sort());
  });
});

describe("normalizeMediaSite", () => {
  it("accepts what a settings field actually receives", () => {
    expect(normalizeMediaSite("YouTube.com")).toBe("youtube.com");
    expect(normalizeMediaSite("  www.netflix.com/browse  ")).toBe("netflix.com");
    expect(normalizeMediaSite("https://user:pass@music.apple.com:443/us?x=1#y")).toBe(
      "music.apple.com",
    );
    expect(normalizeMediaSite("cineby.at.")).toBe("cineby.at");
  });

  it("keeps the hosts a local media server is reached by", () => {
    expect(normalizeMediaSite("http://localhost:8096/web")).toBe("localhost");
    expect(normalizeMediaSite("192.168.1.50:32400")).toBe("192.168.1.50");
    expect(normalizeMediaSite("https://[2001:0DB8::1]:443/web")).toBe("2001:db8::1");
  });

  it("rejects what could never be a stored domain", () => {
    expect(normalizeMediaSite("")).toBe("");
    expect(normalizeMediaSite("not a host")).toBe("");
    expect(normalizeMediaSite("1.2.3")).toBe("");
    expect(normalizeMediaSite("999.1.1.1")).toBe("");
    expect(normalizeMediaSite("-leading.example")).toBe("");
    expect(normalizeMediaSite("example.com:65536")).toBe("");
    expect(normalizeMediaSite("[::1]:nope")).toBe("");
  });
});

describe("normalizeMediaSites", () => {
  it("splits a paste and drops duplicates that differ only in shape", () => {
    expect(normalizeMediaSites("cineby.at\nwww.CINEBY.at, nebula.tv")).toEqual([
      "cineby.at",
      "nebula.tv",
    ]);
  });

  it("reads an empty field as no additions rather than a failure", () => {
    expect(normalizeMediaSites("")).toEqual([]);
    expect(normalizeMediaSites(" , ")).toEqual([]);
  });
});

describe("coveringMediaSite", () => {
  it("names the built-in that already protects a typed site", () => {
    expect(coveringMediaSite("youtube.com")).toBe("youtube.com");
    expect(coveringMediaSite("music.youtube.com")).toBe("youtube.com");
  });

  it("names an existing addition, so a duplicate chip explains itself", () => {
    expect(coveringMediaSite("watch.cineby.at", ["cineby.at"])).toBe("cineby.at");
  });

  it("reports nothing for a site Time does not yet know", () => {
    expect(coveringMediaSite("cineby.at")).toBeNull();
    expect(coveringMediaSite("nebula.tv", ["cineby.at"])).toBeNull();
  });

  it("does not treat a shared suffix fragment as coverage", () => {
    // "notyoutube.com" ends with "youtube.com" as a string but is a different
    // site; only a label boundary counts.
    expect(coveringMediaSite("notyoutube.com")).toBeNull();
  });
});
