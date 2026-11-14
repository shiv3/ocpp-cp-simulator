import { afterEach, describe, expect, it } from "bun:test";

import type { CellularPolicySet } from "../../cp/domain/modem/cellularLink";
import type { ModemConfig } from "../../cp/domain/modem/CellularModem";
import type { WireVersion } from "./FakeCsms";
import { Rig } from "./rig";

/**
 * #930: a suspended / blocked SIM keeps a cellular-only station offline,
 * against every way of dialling; restoring service reconnects it through the
 * normal #609 policy and #702 boot rule. Real station, real socket, fake CSMS.
 */
const ICCID = "8944501234567890123";
const cellular = (extra: Partial<ModemConfig> = {}): ModemConfig => ({
  networkInterface: "cellular",
  sim: { iccid: ICCID, imsi: "310150123456789", operator: "acme" },
  ...extra,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bootCount = (rig: Rig) =>
  rig.csms.frames.filter(
    (f) => f.dir === "CP>" && f.action === "BootNotification",
  ).length;

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.dispose();
});
async function make(
  version: WireVersion,
  modem: ModemConfig,
  options: { noConnect?: boolean; reconnect?: object } = {},
): Promise<Rig> {
  const rig = await Rig.create({
    version,
    noConnect: options.noConnect,
    transportOptions: {
      modem,
      reconnect: {
        mode: "fixed",
        baseDelayMs: 50,
        maxAttempts: 3,
        ...options.reconnect,
      },
    },
  });
  rigs.push(rig);
  return rig;
}

for (const version of ["1.6", "2.0.1"] as const) {
  describe(`cellular link gate, OCPP ${version}`, () => {
    it("tears the link down, ignores connect/reset/reconnect, and restores with a fresh budget", async () => {
      const rig = await make(version, cellular());
      const opens = rig.csms.openCount;
      const boots = bootCount(rig);
      rig.cp.modem!.suspendSubscription();
      await wait(300);
      expect(rig.csms.connected).toBe(false);
      expect(rig.cp.cellularLink()).toMatchObject({
        available: false,
        reasons: ["subscription_suspended"],
      });
      // The station keeps its power and does not count the outage.
      rig.cp.connect();
      rig.cp.connect();
      // Much longer than maxAttempts * baseDelay: an unbounded budget leak
      // would have given up (and stayed down) by now.
      await wait(1200);
      expect(rig.csms.openCount).toBe(opens);
      expect(rig.csms.connected).toBe(false);

      rig.cp.modem!.activateSubscription();
      await rig.reconnected(opens + 1);
      expect(rig.csms.openCount).toBe(opens + 1);
      // 2.x: a pure reconnect with unchanged boot data sends no BootNotification (#702).
      // 1.6 boots on every connect, as it always did.
      expect(bootCount(rig)).toBe(version === "1.6" ? boots + 1 : boots);
    });

    it("a reset while the link is down cannot dial; its own boot goes out when service returns", async () => {
      const rig = await make(version, cellular());
      const opens = rig.csms.openCount;
      const boots = bootCount(rig);
      rig.cp.modem!.suspendSubscription();
      await wait(200);
      rig.cp.reset();
      await wait(800);
      expect(rig.csms.openCount).toBe(opens);
      expect(rig.csms.connected).toBe(false);
      rig.cp.modem!.activateSubscription();
      await rig.csms.waitForCall("BootNotification", {
        nth: boots + 1,
        timeoutMs: 20000,
      });
      expect(rig.csms.openCount).toBe(opens + 1);
    });

    it("a station that starts with a suspended SIM stays offline until activated", async () => {
      const rig = await make(
        version,
        cellular({ sim: { iccid: ICCID, subscription: "suspended" } }),
        { noConnect: true },
      );
      rig.cp.connect();
      await wait(600);
      expect(rig.csms.openCount).toBe(0);
      rig.cp.modem!.activateSubscription();
      await rig.csms.waitForCall("BootNotification", {
        nth: 1,
        timeoutMs: 20000,
      });
      expect(rig.csms.openCount).toBe(1);
    });

    it("an operator disconnect while the link is down cancels the wish to reconnect", async () => {
      const rig = await make(version, cellular());
      rig.cp.modem!.suspendSubscription();
      await wait(200);
      rig.cp.disconnect();
      const opens = rig.csms.openCount;
      rig.cp.modem!.activateSubscription();
      await wait(600);
      expect(rig.csms.openCount).toBe(opens);
    });

    it("an Ethernet station stays connected while its unused SIM is suspended or blocked", async () => {
      const rig = await make(
        version,
        cellular({ networkInterface: "ethernet" }),
      );
      const opens = rig.csms.openCount;
      rig.cp.modem!.suspendSubscription();
      rig.cp.setCellularPolicies({
        all: { match: { operator: "acme" }, service: "blocked" },
      });
      await wait(400);
      expect(rig.csms.connected).toBe(true);
      expect(rig.csms.openCount).toBe(opens);
      expect(rig.cp.cellularLink()).toMatchObject({
        networkInterface: "ethernet",
        available: true,
        reasons: [],
      });
      expect(rig.cp.cellularLink()?.policies.map((p) => p.id)).toEqual(["all"]);
    });

    it("a blocked policy by ICCID or operator takes a cellular station down; replacing the SIM moves it to the policies of the new card", async () => {
      const rig = await make(version, cellular());
      const policies: CellularPolicySet = {
        "by-iccid": { match: { iccid: ICCID }, service: "blocked" },
      };
      rig.cp.setCellularPolicies(policies);
      await wait(300);
      expect(rig.csms.connected).toBe(false);
      expect(rig.cp.cellularLink()).toMatchObject({
        available: false,
        reasons: ["sim_network_blocked"],
        policies: [{ id: "by-iccid", by: "iccid", service: "blocked" }],
      });
      // A card the policy does not select: service returns without touching the policy.
      rig.cp.modem!.replaceSim({
        iccid: "8900000000000000002",
        operator: "other",
      });
      await rig.reconnected(2);
      expect(rig.cp.cellularLink()?.available).toBe(true);
      // An operator-scoped policy catches a later card of that group, no per-CP rule needed.
      rig.cp.setCellularPolicies({
        group: { match: { operator: "other" }, service: "blocked" },
      });
      await wait(300);
      expect(rig.csms.connected).toBe(false);
      rig.cp.setCellularPolicies({});
      await rig.reconnected(3);
      expect(rig.cp.cellularLink()?.available).toBe(true);
    });

    it("a missing SIM is an outage with its own reason; inserting one restores", async () => {
      const rig = await make(version, cellular());
      rig.cp.modem!.removeSim();
      await wait(300);
      expect(rig.cp.cellularLink()).toMatchObject({
        available: false,
        reasons: ["sim_missing"],
      });
      expect(rig.csms.connected).toBe(false);
      rig.cp.modem!.insertSim({ iccid: "8900000000000000003" });
      await rig.reconnected(2);
      expect(rig.cp.cellularLink()?.available).toBe(true);
    });

    it("emits one event per availability change (not per reason change), with no error", async () => {
      const rig = await make(version, cellular());
      const seen: string[] = [];
      rig.cp.events.on("cellularLinkChanged", (e) =>
        seen.push(
          `${e.previouslyAvailable}->${e.available}:${e.reasons.join(",")}`,
        ),
      );
      rig.cp.modem!.suspendSubscription();
      rig.cp.modem!.removeSim();
      rig.cp.modem!.insertSim({ iccid: "8900000000000000004" });
      await wait(100);
      expect(seen).toEqual([
        "true->false:subscription_suspended",
        "false->true:",
      ]);
      expect(rig.cp.error).toBe("");
    });
  });
}

describe("cellular bandwidth caps on the wire (#930)", () => {
  it("delays larger frames by their size, in order, and lifts with the policy", async () => {
    const rig = await make("1.6", cellular());
    rig.cp.setCellularPolicies({
      slow: { match: { operator: "acme" }, upstreamBytesPerSecond: 2000 },
    });
    expect(rig.cp.cellularLink()).toMatchObject({
      available: true,
      upstreamBytesPerSecond: 2000,
      downstreamBytesPerSecond: null,
    });
    const body = (n: number) => "x".repeat(n);
    const started = Date.now();
    // ~1 KB each: about half a second of link time per frame at 2 kB/s.
    rig.cp.sendDataTransfer("v", "m1", body(1000)).catch(() => {});
    rig.cp.sendDataTransfer("v", "m2", body(1000)).catch(() => {});
    await rig.csms.waitForCall("DataTransfer", { nth: 1, timeoutMs: 10000 });
    const first = Date.now() - started;
    await rig.csms.waitForCall("DataTransfer", { nth: 2, timeoutMs: 10000 });
    const second = Date.now() - started;
    expect(first).toBeGreaterThanOrEqual(450);
    expect(second).toBeGreaterThanOrEqual(900);
    const order = rig.csms.frames
      .filter((f) => f.dir === "CP>" && f.action === "DataTransfer")
      .map((f) => (f.payload as { messageId: string }).messageId);
    expect(order).toEqual(["m1", "m2"]);

    rig.cp.setCellularPolicies({});
    const t = Date.now();
    rig.cp.sendDataTransfer("v", "m3", body(1000)).catch(() => {});
    await rig.csms.waitForCall("DataTransfer", { nth: 3, timeoutMs: 10000 });
    expect(Date.now() - t).toBeLessThan(400);
  });
});
