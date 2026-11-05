import { describe, it, expect } from "vitest";

import { formatEvent } from "../output";

describe("formatEvent", () => {
  it("renders boot_notification with the CSMS status and interval (#395)", () => {
    expect(
      formatEvent("boot_notification", {
        status: "Pending",
        interval: 30,
        currentTime: "2026-09-30T12:00:00.000Z",
      }),
    ).toBe("[EVENT] BootNotification Pending (interval: 30s)");
  });
});
