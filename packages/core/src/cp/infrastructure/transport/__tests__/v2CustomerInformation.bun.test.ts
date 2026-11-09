import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { splitCustomerInformation } from "../v201/customerInformationV201";

const VERSIONS = ["OCPP-2.0.1", "OCPP-2.1"] as const;

const resultOf = (id: string) => (f: OcppFrame) => f[0] === 3 && f[1] === id;
const notifications = (csms: MockCsms) =>
  csms.received.filter(
    (f) => f[0] === 2 && f[2] === "NotifyCustomerInformation",
  );

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "StatusNotification" &&
      (f[3] as { connectorStatus?: string }).connectorStatus === "Available",
  );
}

async function withStation(
  version: (typeof VERSIONS)[number],
  run: (
    csms: MockCsms,
    cp: ChargePoint,
    ask: (payload: object) => Promise<OcppFrame>,
  ) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = createChargePoint(
    "CP-CUSTINFO",
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  let n = 0;
  try {
    cp.connect();
    await bootAccepted(csms);
    cp.authorization.seedCache([{ idToken: "TAG-C", status: "Accepted" }]);
    cp.localAuthListManager.applyFull(
      3,
      [{ idTag: "tag-c", idTagInfo: { status: "Blocked" } }],
      { sendLocalListMaxLength: 10, localAuthListMaxLength: 10 },
    );
    await run(csms, cp, async (payload) => {
      const id = `ci-${++n}`;
      csms.send([2, id, "CustomerInformation", payload]);
      return csms.waitForFrame(resultOf(id));
    });
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

const token = { idToken: "tag-c", type: "Central" };

describe.each(VERSIONS)("%s CustomerInformation (#602)", (version) => {
  it("reports the held data in NotifyCustomerInformation after the answer", async () => {
    await withStation(version, async (csms, cp, ask) => {
      const result = await ask({
        requestId: 5,
        report: true,
        clear: false,
        idToken: token,
      });
      expect(result[2]).toEqual({ status: "Accepted" });
      const note = await csms.waitForCall("NotifyCustomerInformation");
      const frame = notifications(csms)[0]!;
      expect(csms.received.indexOf(frame)).toBeGreaterThan(
        csms.received.indexOf(result),
      );
      const body = note.payload as Record<string, unknown>;
      expect(body).toMatchObject({ requestId: 5, seqNo: 0 });
      expect(body.tbc).toBeUndefined();
      expect(typeof body.generatedAt).toBe("string");
      expect(body.data).toContain("Authorization cache TAG-C: status Accepted");
      expect(body.data).toContain(
        "Local authorization list tag-c: status Blocked",
      );
      // report alone clears nothing
      expect(cp.authorization.cache.get("TAG-C")).toBeDefined();
    });
  });

  it("clear removes the matching cache entries and sends no report", async () => {
    await withStation(version, async (csms, cp, ask) => {
      cp.authorization.seedCache([{ idToken: "OTHER", status: "Accepted" }]);
      const result = await ask({
        requestId: 6,
        report: false,
        clear: true,
        idToken: token,
      });
      expect(result[2]).toEqual({ status: "Accepted" });
      await new Promise((r) => setTimeout(r, 100));
      expect(cp.authorization.cache.get("TAG-C")).toBeUndefined();
      expect(cp.authorization.cache.get("OTHER")).toBeDefined();
      // the Local Authorization List belongs to the CSMS
      expect(cp.localAuthListManager.getEntry("TAG-C")).toBeDefined();
      expect(notifications(csms)).toHaveLength(0);
    });
  });

  it("matches customerIdentifier too, and report + clear reports before it clears", async () => {
    await withStation(version, async (csms, cp, ask) => {
      const result = await ask({
        requestId: 7,
        report: true,
        clear: true,
        customerIdentifier: "TAG-C",
      });
      expect(result[2]).toEqual({ status: "Accepted" });
      const note = await csms.waitForCall("NotifyCustomerInformation");
      const data = (note.payload as { data: string }).data;
      expect(data).toContain("Authorization cache TAG-C: status Accepted");
      expect(data).toContain("Cleared 1 authorization cache entries");
      expect(cp.authorization.cache.get("TAG-C")).toBeUndefined();
    });
  });

  it("reports an unknown customer as holding nothing", async () => {
    await withStation(version, async (csms, _cp, ask) => {
      await ask({
        requestId: 8,
        report: true,
        clear: false,
        customerIdentifier: "NOBODY",
      });
      const note = await csms.waitForCall("NotifyCustomerInformation");
      expect((note.payload as { data: string }).data).toContain(
        "Authorization cache NOBODY: no entry",
      );
    });
  });

  it("rejects a request with neither report nor clear, and flags a missing customer", async () => {
    await withStation(version, async (csms, cp, ask) => {
      expect(
        (
          await ask({
            requestId: 9,
            report: false,
            clear: false,
            idToken: token,
          })
        )[2],
      ).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "NoAction" },
      });
      expect(
        (await ask({ requestId: 10, report: true, clear: true }))[2],
      ).toMatchObject({
        status: "Invalid",
        statusInfo: { reasonCode: "MissingParam" },
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(cp.authorization.cache.get("TAG-C")).toBeDefined();
      expect(notifications(csms)).toHaveLength(0);
    });
  });
});

describe("splitCustomerInformation", () => {
  it("cuts at the 512 character limit and keeps surrogate pairs whole", () => {
    expect(splitCustomerInformation("")).toEqual([""]);
    expect(
      splitCustomerInformation("a".repeat(1100)).map((p) => p.length),
    ).toEqual([512, 512, 76]);
    const parts = splitCustomerInformation("a".repeat(511) + "😀" + "b", 512);
    expect(parts.join("")).toBe("a".repeat(511) + "😀" + "b");
    expect(parts.every((p) => p.length <= 512)).toBe(true);
    expect(parts[0]).toBe("a".repeat(511));
  });
});
