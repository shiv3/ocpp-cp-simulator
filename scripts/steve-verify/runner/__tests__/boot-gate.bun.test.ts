import { describe, expect, test } from "bun:test";
import { BOOT_ACCEPTED_PATTERN } from "../boot-gate";

const PREFIX =
  '[2026-07-12T01:17:58.189Z] [INFO] [WebSocket] Received: [3,"102f1228-84cd-449e-9ccf-c1bcd4d5be7d",';

describe("BOOT_ACCEPTED_PATTERN (issue #262)", () => {
  test("matches SteVe key order (status first)", () => {
    const line = `${PREFIX}{"status":"Accepted","currentTime":"2026-07-12T01:17:58.182Z","interval":14400}]`;
    expect(BOOT_ACCEPTED_PATTERN.test(line)).toBe(true);
  });

  test("matches the reverse key order (currentTime first)", () => {
    // The shape the non-SteVe CSMS in #262 emits.
    const line = `${PREFIX}{"currentTime":"2026-07-12T01:17:58.182Z","interval":14400,"status":"Accepted"}]`;
    expect(BOOT_ACCEPTED_PATTERN.test(line)).toBe(true);
  });

  test("does not match a Rejected boot", () => {
    const line = `${PREFIX}{"status":"Rejected","currentTime":"2026-07-12T01:17:58.182Z","interval":14400}]`;
    expect(BOOT_ACCEPTED_PATTERN.test(line)).toBe(false);
  });

  test("does not match an Accepted CALLRESULT that has no currentTime (e.g. RemoteStart.conf)", () => {
    const line = `${PREFIX}{"status":"Accepted"}]`;
    expect(BOOT_ACCEPTED_PATTERN.test(line)).toBe(false);
  });

  test("does not match a CALL frame (`[2,`) or a non-frame line", () => {
    expect(
      BOOT_ACCEPTED_PATTERN.test(
        '[..] Received: [2,"id","BootNotification",{"status":"Accepted","currentTime":"x"}]',
      ),
    ).toBe(false);
    expect(
      BOOT_ACCEPTED_PATTERN.test("[..] [WebSocket] WebSocket connected"),
    ).toBe(false);
  });
});
