import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { bootedChargePoint } from "./stationHarness";

// D02.FR.01-03 (2.0.1 ed4 / 2.1 ed2 Part 2): version 0 when the list is
// disabled or was never updated; 1.6 §5.10 keeps -1 for a disabled list (#695).
async function versionOf(csms: MockCsms, id: string): Promise<unknown> {
  csms.send([2, id, "GetLocalListVersion", {}]);
  const frame = await csms.waitForFrame((f) => f[0] === 3 && f[1] === id);
  const body = frame[2] as { versionNumber?: number; listVersion?: number };
  return body.versionNumber ?? body.listVersion;
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])("%s GetLocalListVersion", (v) => {
  it("answers 0 when disabled, 0 before any update, then the version", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP695", v);
    try {
      cp.configuration.applyChange("LocalAuthListEnabled", "false");
      expect(await versionOf(csms, "g-1")).toBe(0); // D02.FR.03

      cp.configuration.applyChange("LocalAuthListEnabled", "true");
      expect(await versionOf(csms, "g-2")).toBe(0); // D02.FR.02

      csms.send([
        2,
        "s-1",
        "SendLocalList",
        {
          versionNumber: 5,
          updateType: "Full",
          localAuthorizationList: [
            {
              idToken: { idToken: "TAG1", type: "ISO14443" },
              idTokenInfo: { status: "Accepted" },
            },
          ],
        },
      ]);
      await csms.waitForFrame((f) => f[0] === 3 && f[1] === "s-1");
      expect(await versionOf(csms, "g-3")).toBe(5); // D02.FR.01

      cp.configuration.applyChange("LocalAuthListEnabled", "false");
      expect(await versionOf(csms, "g-4")).toBe(0); // D02.FR.03
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});

describe("OCPP-1.6J GetLocalListVersion", () => {
  it("still answers -1 when the list is disabled", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP695-16", "OCPP-1.6J");
    try {
      cp.configuration.applyChange("LocalAuthListEnabled", "false");
      expect(await versionOf(csms, "g-1")).toBe(-1);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
