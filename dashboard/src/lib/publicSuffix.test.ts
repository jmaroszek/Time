import { describe, expect, it } from "vitest";

import { isPublicSuffix, publicSuffixOf } from "./publicSuffix";

/**
 * The list is published with a test table that asserts the *registrable*
 * domain — the public suffix plus one label — so the cases below are checked
 * through this rather than against `publicSuffixOf` directly. `null` means the
 * input is a public suffix and so has no registrable form.
 */
function registrableDomain(domain: string): string | null {
  const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized) return null;
  const suffix = publicSuffixOf(normalized);
  if (normalized === suffix) return null;
  const head = normalized.slice(0, normalized.length - suffix.length - 1).split(".");
  return `${head[head.length - 1]}.${suffix}`;
}

describe("the published test table", () => {
  it("handles mixed case", () => {
    expect(registrableDomain("COM")).toBeNull();
    expect(registrableDomain("example.COM")).toBe("example.com");
    expect(registrableDomain("WwW.example.COM")).toBe("example.com");
  });

  it("treats an unlisted TLD as a boundary via the implicit wildcard", () => {
    expect(registrableDomain("example")).toBeNull();
    expect(registrableDomain("example.example")).toBe("example.example");
    expect(registrableDomain("b.example.example")).toBe("example.example");
  });

  it("handles a TLD with one rule", () => {
    expect(registrableDomain("biz")).toBeNull();
    expect(registrableDomain("domain.biz")).toBe("domain.biz");
    expect(registrableDomain("b.domain.biz")).toBe("domain.biz");
  });

  it("handles a TLD with two-level rules", () => {
    expect(registrableDomain("com")).toBeNull();
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("b.example.com")).toBe("example.com");
    expect(registrableDomain("uk.com")).toBeNull();
    expect(registrableDomain("example.uk.com")).toBe("example.uk.com");
    expect(registrableDomain("b.example.uk.com")).toBe("example.uk.com");
  });

  it("handles a TLD whose only rule is a wildcard", () => {
    expect(registrableDomain("mm")).toBeNull();
    expect(registrableDomain("c.mm")).toBeNull();
    expect(registrableDomain("b.c.mm")).toBe("b.c.mm");
    expect(registrableDomain("a.b.c.mm")).toBe("b.c.mm");
  });

  it("handles a more complex TLD", () => {
    expect(registrableDomain("jp")).toBeNull();
    expect(registrableDomain("test.jp")).toBe("test.jp");
    expect(registrableDomain("www.test.jp")).toBe("test.jp");
    expect(registrableDomain("ac.jp")).toBeNull();
    expect(registrableDomain("test.ac.jp")).toBe("test.ac.jp");
    expect(registrableDomain("kyoto.jp")).toBeNull();
    expect(registrableDomain("test.kyoto.jp")).toBe("test.kyoto.jp");
  });

  it("lets an exception rule beat the wildcard it sits under", () => {
    // *.ck makes every second-level name a boundary, and !www.ck carves one
    // back out — the case that separates a correct matcher from a plausible one.
    expect(registrableDomain("test.ck")).toBeNull();
    expect(registrableDomain("b.test.ck")).toBe("b.test.ck");
    expect(registrableDomain("www.ck")).toBe("www.ck");
    expect(registrableDomain("www.www.ck")).toBe("www.ck");

    // A listed second level is a boundary, and names under it are registrable.
    expect(registrableDomain("ide.kyoto.jp")).toBeNull();
    expect(registrableDomain("b.ide.kyoto.jp")).toBe("b.ide.kyoto.jp");

    // The same wildcard-plus-exception shape inside .jp. Note kobe.jp itself is
    // absent from the list, so it stays registrable under jp — only its
    // children are boundaries, and city.kobe.jp is carved back out of those.
    expect(registrableDomain("kobe.jp")).toBe("kobe.jp");
    expect(registrableDomain("c.kobe.jp")).toBeNull();
    expect(registrableDomain("b.c.kobe.jp")).toBe("b.c.kobe.jp");
    expect(registrableDomain("city.kobe.jp")).toBe("city.kobe.jp");
    expect(registrableDomain("www.city.kobe.jp")).toBe("city.kobe.jp");
  });
});

describe("isPublicSuffix", () => {
  it("rejects the parents that would classify a whole country", () => {
    // The reason the list is vendored at all.
    expect(isPublicSuffix("co.uk")).toBe(true);
    expect(isPublicSuffix("com.au")).toBe(true);
    expect(isPublicSuffix("co.jp")).toBe(true);
    expect(isPublicSuffix("com")).toBe(true);
    expect(isPublicSuffix("org")).toBe(true);
  });

  it("rejects shared hosts whose subdomains have unrelated owners", () => {
    expect(isPublicSuffix("github.io")).toBe(true);
    expect(isPublicSuffix("vercel.app")).toBe(true);
  });

  it("accepts real registrable names under those same suffixes", () => {
    expect(isPublicSuffix("bbc.co.uk")).toBe(false);
    expect(isPublicSuffix("google.com")).toBe(false);
    expect(isPublicSuffix("someone.github.io")).toBe(false);
  });

  it("treats an unknown TLD as a boundary, so a new one cannot become a rule", () => {
    expect(isPublicSuffix("madeuptld")).toBe(true);
    expect(isPublicSuffix("example.madeuptld")).toBe(false);
  });

  it("has no answer for an empty name", () => {
    expect(isPublicSuffix("")).toBe(false);
    expect(isPublicSuffix(".")).toBe(false);
    expect(publicSuffixOf("")).toBe("");
  });
});

describe("normalization", () => {
  it("is case insensitive", () => {
    expect(publicSuffixOf("BBC.CO.UK")).toBe("co.uk");
    expect(isPublicSuffix("CO.UK")).toBe(true);
  });

  it("ignores stray leading and trailing dots", () => {
    // The published table calls a leading dot invalid input. Being lenient here
    // is deliberate and cannot mislead: every domain reaching this module has
    // already been through the tracker's host cleaning or normalizeRulePattern,
    // both of which strip stray dots, so the only callers that could hit this
    // are ones that meant the bare name.
    expect(publicSuffixOf("bbc.co.uk.")).toBe("co.uk");
    expect(publicSuffixOf(".bbc.co.uk")).toBe("co.uk");
  });
});
