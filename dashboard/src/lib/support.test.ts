import { describe, expect, it } from "vitest";

import { SUPPORT_EMAIL, supportEmailUrl } from "./support";

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
});
