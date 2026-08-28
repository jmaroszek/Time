import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL, supportEmailUrl, supportSubject, type SupportTopic } from "./support";

const TOPICS: SupportTopic[] = ["general", "praise", "problem", "extension"];

describe("support email", () => {
  it("addresses the combined support channel with useful diagnostic prompts", () => {
    const url = new URL(supportEmailUrl({
      dashboardVersion: "1.2.3",
      trackerVersion: "4.5.6",
    }));

    expect(`${url.protocol}${url.pathname}`).toBe(`mailto:${SUPPORT_EMAIL}`);
    expect(url.searchParams.get("subject")).toBe("Time support or feedback");
    const body = url.searchParams.get("body");
    expect(body).toContain(
      "Time versions: Dashboard 1.2.3 · Tracker 4.5.6",
    );
    expect(body?.startsWith("What would you like to share?\n\n")).toBe(true);
    expect(body).not.toContain("Before sending");
  });

  it("keeps the action available before either version is reported", () => {
    const url = new URL(supportEmailUrl({}));

    expect(url.searchParams.get("body")).toContain(
      "Time versions: Dashboard not available · Tracker not stamped yet",
    );
  });

  it("keeps the Settings subject unchanged", () => {
    // Settings' own button predates the prompts and its allowlist entry is the
    // one already shipped. A rename here would break it on user machines only.
    expect(supportSubject("general")).toBe("Time support or feedback");
  });

  it("asks a happy reader and an unhappy one different questions", () => {
    const praise = new URL(supportEmailUrl({}, "praise")).searchParams.get("body");
    const problem = new URL(supportEmailUrl({}, "problem")).searchParams.get("body");

    expect(praise).toContain("What is Time doing best for you?");
    expect(praise).toContain("May I quote you on trackwithtime.com?");
    expect(problem).toContain("What went wrong?");
    expect(problem).toContain("Your Windows version");
  });

  it("asks the extension reader about their browser", () => {
    const body = new URL(supportEmailUrl({}, "extension")).searchParams.get("body");

    expect(body).toContain("Which browser");
  });

  it("carries how long Time has been in use when the caller knows", () => {
    expect(new URL(supportEmailUrl({ daysOfUse: 63 }, "problem")).searchParams.get("body"))
      .toContain("Using Time for 63 days");
    expect(new URL(supportEmailUrl({ daysOfUse: 1 }, "problem")).searchParams.get("body"))
      .toContain("Using Time for 1 day");
  });

  it("omits the duration rather than guessing at it", () => {
    const body = new URL(supportEmailUrl({}, "problem")).searchParams.get("body");

    expect(body).not.toContain("Using Time for");
  });

  it("gives every topic a distinct subject", () => {
    const subjects = TOPICS.map(supportSubject);

    expect(new Set(subjects).size).toBe(TOPICS.length);
  });
});

describe("opener allowlist", () => {
  /**
   * Every subject must be pinned in the capability file.
   *
   * The allowlist matches the subject literally and only wildcards the body, so
   * a subject that is not pinned is refused by the opener at runtime — on a
   * user's machine, in the one moment they were trying to reach support, with
   * nothing failing at build time to warn about it. This is the gate that turns
   * that into a test failure instead.
   */
  const capabilities: { permissions: unknown[] } = JSON.parse(
    readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  );
  const allowed = new Set(
    capabilities.permissions
      .flatMap((permission) =>
        typeof permission === "object" && permission !== null && "allow" in permission
          ? ((permission as { allow: { url: string }[] }).allow ?? [])
          : [],
      )
      .map((entry) => entry.url),
  );

  it.each(TOPICS)("pins the %s subject", (topic) => {
    const subject = encodeURIComponent(supportSubject(topic));

    expect(allowed).toContain(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=*`);
  });

  it("builds URLs the allowlist pattern actually matches", () => {
    // The pattern wildcards only the body, so the parameter order the builder
    // emits is part of the contract too.
    for (const topic of TOPICS) {
      const url = supportEmailUrl({ dashboardVersion: "1.0.0" }, topic);
      const prefix = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(supportSubject(topic))}&body=`;
      expect(url.startsWith(prefix)).toBe(true);
    }
  });
});
