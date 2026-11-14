// Opt-in firmware and log lifecycles of the default behaviors (#600, #601), on
// the virtual clock: the OCPP 2.x firmware train, waiting for transactions,
// connectors held Unavailable, the reboot, retries, a replaced request; the
// 2.x GetLog upload. OCPP clause ids: 2.0.1 ed4 L01.FR.* and N01.FR.*, 1.6 §5.19.
import { afterEach, describe, expect, test } from "bun:test";
import type {
  Behavior,
  BehaviorContext,
  JsonObject,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { firmwareBehavior } from "../../cp/application/engine/behaviors/firmware";
import { logsBehavior } from "../../cp/application/engine/behaviors/logs";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { SIGNING_CERTIFICATE } from "../../cp/domain/security/__tests__/signingCertificateFixture";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const select = (r: BehaviorRun, params: JsonObject, id = "default.firmware") =>
  r.cp.engine.activateBehavior(
    id,
    { kind: "code", behaviorId: "test" },
    params,
  );
const fw2 = (requestId: number, extra: Record<string, unknown> = {}) => ({
  requestId,
  firmware: {
    location: "https://fw.example/f.bin",
    retrieveDateTime: "2020-01-01T00:00:00.000Z",
    ...extra,
  },
});
const fw16 = {
  location: "http://fw.example/f.bin",
  retrieveDate: "2020-01-01T00:00:00.000Z",
};
const sent = (r: BehaviorRun, action = "FirmwareStatusNotification") =>
  r.callsOf(action).map((f) => f.payload as Record<string, unknown>);
const statuses = (r: BehaviorRun, action?: string) =>
  sent(r, action).map((p) => p.status);
/** [virtual ms since the call, status] of every firmware notification. */
async function timeline(
  r: BehaviorRun,
  totalMs: number,
  stepMs = 50,
): Promise<Array<[number, unknown]>> {
  const start = r.clock.now();
  const seen: Array<[number, unknown]> = [];
  for (let at = 0; at < totalMs; at += stepMs) {
    await r.advance(stepMs);
    for (const s of statuses(r).slice(seen.length)) {
      seen.push([r.clock.now() - start, s]);
    }
  }
  return seen;
}
const reply = (frame: { payload: unknown }) =>
  (frame.payload as { status?: string }).status;

describe("OCPP 2.x firmware train (#600)", () => {
  test("without the param the station only acknowledges (default wire)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    expect(reply(await run.call("UpdateFirmware", fw2(1)))).toBe("Accepted");
    await run.advance(20_000);
    expect(statuses(run)).toEqual([]);
  });

  test("train: every status carries the requestId; a signature adds SignatureVerified; FirmwareUpdated follows Installed", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100 });
    const answer = await run.call(
      "UpdateFirmware",
      fw2(4, { signingCertificate: SIGNING_CERTIFICATE, signature: "s" }),
    );
    expect(reply(answer)).toBe("Accepted");
    await run.advance(1000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "SignatureVerified",
      "Installing",
      "Installed",
    ]);
    expect(sent(run).every((p) => p.requestId === 4)).toBe(true);
    expect(sent(run, "SecurityEventNotification").map((p) => p.type)).toEqual([
      "FirmwareUpdated",
    ]);
  });

  test("a request without a signature skips the signature step", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100 });
    await run.call("UpdateFirmware", fw2(5));
    await run.advance(1000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("failAt InvalidSignature ends the train with the InvalidFirmwareSignature security event (L01.FR.03)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100, failAt: "InvalidSignature" });
    await run.call(
      "UpdateFirmware",
      fw2(6, { signingCertificate: SIGNING_CERTIFICATE, signature: "s" }),
    );
    await run.advance(2000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "InvalidSignature",
    ]);
    expect(sent(run, "SecurityEventNotification").map((p) => p.type)).toEqual([
      "InvalidFirmwareSignature",
    ]);
  });

  test.each(["InstallationFailed", "InstallVerificationFailed"])(
    "failAt %s is reported after Installing",
    async (failAt) => {
      run = await runBehavior({ version: "2.0.1" });
      select(run, { train: true, stepMs: 100, failAt });
      await run.call("UpdateFirmware", fw2(7));
      await run.advance(2000);
      expect(statuses(run)).toEqual([
        "Downloading",
        "Downloaded",
        "Installing",
        failAt,
      ]);
    },
  );

  test("the one-shot SimulatedFirmwareUpdateFailure key still works, and is consumed", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100 });
    run.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    await run.call("UpdateFirmware", fw2(8));
    await run.advance(1000);
    expect(statuses(run)).toEqual(["Downloading", "DownloadFailed"]);
    expect(
      run.cp.configuration.getString("SimulatedFirmwareUpdateFailure"),
    ).toBe("");
    await run.call("UpdateFirmware", fw2(9));
    await run.advance(1000);
    expect(statuses(run).slice(2)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("1.6 ignores the 2.x-only failAt values, with the happy train", async () => {
    run = await runBehavior({ version: "1.6" });
    select(run, { stepMs: 100, failAt: "InvalidSignature" });
    await run.call("UpdateFirmware", fw16);
    await run.advance(1000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  test("retries and retryInterval: Downloading per attempt, DownloadFailed after the last (L01.FR.30)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100, failAt: "DownloadFailed" });
    await run.call("UpdateFirmware", {
      ...fw2(10),
      retries: 2,
      retryInterval: 3,
    });
    const events = await timeline(run, 7000);
    expect(events).toEqual([
      [50, "Downloading"],
      [3100, "Downloading"],
      [6200, "Downloading"],
      [6300, "DownloadFailed"],
    ]);
  });

  test("a request that replaces one in progress is answered AcceptedCanceled and the first train ends (L01.FR.24)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 1000 });
    expect(reply(await run.call("UpdateFirmware", fw2(1)))).toBe("Accepted");
    await run.advance(1500); // Downloading, Downloaded for 1
    expect(reply(await run.call("UpdateFirmware", fw2(2)))).toBe(
      "AcceptedCanceled",
    );
    await run.advance(10_000);
    const byRequest = (id: number) =>
      sent(run!)
        .filter((p) => p.requestId === id)
        .map((p) => p.status);
    expect(byRequest(1)).toEqual(["Downloading", "Downloaded"]);
    expect(byRequest(2)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
    // Nothing is in flight any more: the next request is plainly accepted.
    expect(reply(await run.call("UpdateFirmware", fw2(3)))).toBe("Accepted");
  });

  test("a future retrieveDateTime is DownloadScheduled (L01.FR.13), a future installDateTime InstallScheduled (L01.FR.16)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100 });
    const at = (ms: number) => new Date(run!.clock.now() + ms).toISOString();
    await run.call("UpdateFirmware", {
      requestId: 11,
      firmware: {
        location: "https://fw.example/f.bin",
        retrieveDateTime: at(2000),
        installDateTime: at(4000),
      },
    });
    const events = await timeline(run, 5000);
    expect(events.map(([, s]) => s)).toEqual([
      "DownloadScheduled",
      "Downloading",
      "Downloaded",
      "InstallScheduled",
      "Installing",
      "Installed",
    ]);
    const time = (s: string) => events.find(([, x]) => x === s)![0];
    expect(time("Downloading")).toBeGreaterThanOrEqual(2000);
    expect(time("Installing")).toBeGreaterThanOrEqual(4000);
  });

  test("the same seed gives the same timing, another seed another one", async () => {
    const timing = async (seed: string) => {
      const r = await runBehavior({ version: "2.0.1", seed });
      try {
        select(r, { train: true, stepMs: 100, jitterMs: 400 });
        await r.call("UpdateFirmware", fw2(12));
        return await timeline(r, 3000);
      } finally {
        await r.dispose();
      }
    };
    const a = await timing("seed-a");
    expect(a.map(([, s]) => s)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
    expect(await timing("seed-a")).toEqual(a);
    expect(await timing("seed-b")).not.toEqual(a);
  });
});

/** A session on connector 1: plug in at 0.5 s, charge, stop after `chargeMs`. */
const session = (chargeMs: number): Behavior => ({
  api: 1,
  id: "session",
  requires: ["physical"],
  main: async (ctx) => {
    ctx.plugIn(1);
    await ctx.sleep(500);
    ctx.startCharging(1, "TAG-1");
    await ctx.sleep(chargeMs);
    ctx.stopCharging(1, "Local");
    await ctx.sleep(500);
    ctx.unplug(1);
  },
});

describe("transactions and connectors during an update (#600)", () => {
  test.each([
    ["1.6", () => ({}), fw16],
    ["2.0.1", () => ({ train: true }), fw2(20)],
  ] as const)(
    "waitForTransactions holds Installing until the session ends, connectorsUnavailable parks the idle connector, both undone after (%s)",
    async (version, extra, request) => {
      run = await runBehavior({
        version,
        connectors: 2,
        behaviors: [session(8000)],
      });
      select(run, {
        ...extra(),
        stepMs: 100,
        waitForTransactions: true,
        connectorsUnavailable: true,
      });
      await run.advance(2000);
      expect(run.cp.getConnector(1)?.transaction).toBeTruthy();
      await run.call("UpdateFirmware", request);
      await run.advance(3000);
      expect(statuses(run)).toEqual(
        ["Downloading", "Downloaded"].concat(
          version === "2.0.1" ? ["InstallScheduled"] : [],
        ),
      );
      // The idle connector is parked; the one in use is left alone.
      expect(run.cp.getConnector(2)?.status).toBe(OCPPStatus.Unavailable);
      expect(run.cp.getConnector(2)?.availability).toBe("Inoperative");
      expect(run.cp.getConnector(1)?.status).not.toBe(OCPPStatus.Unavailable);

      await run.advance(8000); // the session ends at about 9.5 s
      expect(statuses(run).slice(-2)).toEqual(["Installing", "Installed"]);
      await run.advance(3000);
      expect(run.cp.getConnector(2)?.status).toBe(OCPPStatus.Available);
      expect(run.cp.getConnector(2)?.availability).toBe("Operative");
      expect(run.cp.getConnector(1)?.availability).toBe("Operative");
      // The parking is told to the CSMS and undone the same way.
      const states = run
        .callsOf("StatusNotification")
        .map((f) => f.payload as Record<string, unknown>)
        .filter((p) => (p.evseId ?? p.connectorId) === 2)
        .map((p) => p.status ?? p.connectorStatus);
      expect(states.slice(-2)).toEqual(["Unavailable", "Available"]);
    },
  );

  test("connectorsUnavailable alone parks idle connectors while installing only", async () => {
    run = await runBehavior({ version: "1.6", connectors: 2 });
    select(run, { stepMs: 1000, connectorsUnavailable: true });
    await run.call("UpdateFirmware", fw16);
    await run.advance(500);
    expect(run.cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    await run.advance(2000); // Installing at 2 s
    expect(run.cp.getConnector(1)?.status).toBe(OCPPStatus.Unavailable);
    expect(run.cp.getConnector(2)?.status).toBe(OCPPStatus.Unavailable);
    await run.advance(3000);
    expect(statuses(run).at(-1)).toBe("Installed");
    expect(run.cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
  });

  test("a failed update gives the connectors back", async () => {
    run = await runBehavior({ version: "1.6", connectors: 2 });
    select(run, {
      stepMs: 200,
      connectorsUnavailable: true,
      failAt: "InstallationFailed",
    });
    await run.call("UpdateFirmware", fw16);
    await run.advance(2000);
    expect(statuses(run).at(-1)).toBe("InstallationFailed");
    expect(run.cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    expect(run.cp.getConnector(1)?.availability).toBe("Operative");
  });
});

describe("reboot after the update (#600)", () => {
  test("1.6 beforeInstalled: BootNotification first, Installed once accepted (§5.19)", async () => {
    run = await runBehavior({ version: "1.6" });
    select(run, { stepMs: 100, reboot: "beforeInstalled" });
    await run.call("UpdateFirmware", fw16);
    await run.advance(2000);
    const order = run
      .frames()
      .filter(
        (f) =>
          f.dir === "CP>" &&
          f.kind === "call" &&
          (f.action === "BootNotification" ||
            f.action === "FirmwareStatusNotification"),
      )
      .map((f) =>
        f.action === "BootNotification"
          ? "Boot"
          : (f.payload as { status: string }).status,
      );
    expect(order).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Boot",
      "Installed",
    ]);
  });

  test("2.x beforeInstalled: InstallRebooting, boot, Installed with the requestId (L01.FR.15, FR.32 a)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100, reboot: "beforeInstalled" });
    await run.call("UpdateFirmware", fw2(30));
    await run.advance(2000);
    expect(statuses(run)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "InstallRebooting",
      "Installed",
    ]);
    expect(sent(run).at(-1)?.requestId).toBe(30);
    expect(run.callsOf("BootNotification")).toHaveLength(1);
  });

  // L01.FR.33 (#846): activating the firmware waits for the transactions to
  // end even when waitForTransactions only governs the install start.
  test("2.x reboot waits for a running transaction although waitForTransactions is off", async () => {
    run = await runBehavior({
      version: "2.0.1",
      connectors: 2,
      behaviors: [session(8000)],
    });
    select(run, { train: true, stepMs: 100, reboot: "afterInstalled" });
    await run.advance(2000);
    expect(run.cp.getConnector(1)?.transaction).toBeTruthy();
    await run.call("UpdateFirmware", fw2(33));
    await run.advance(3000);
    expect(statuses(run).at(-1)).toBe("Installed");
    expect(run.callsOf("BootNotification")).toHaveLength(0);

    await run.advance(8000); // the session ends at about 9.5 s
    expect(run.callsOf("BootNotification")).toHaveLength(1);
  });

  // L01.FR.07 (#871): idle EVSEs stay held Unavailable while the reboot waits
  // for the running transaction.
  test("2.x reboot wait holds idle EVSEs Unavailable with connectorsUnavailable", async () => {
    run = await runBehavior({
      version: "2.0.1",
      connectors: 2,
      behaviors: [session(8000)],
    });
    select(run, {
      train: true,
      stepMs: 100,
      reboot: "afterInstalled",
      connectorsUnavailable: true,
    });
    await run.advance(2000);
    expect(run.cp.getConnector(1)?.transaction).toBeTruthy();
    await run.call("UpdateFirmware", fw2(34));
    await run.advance(3000);
    expect(run.callsOf("BootNotification")).toHaveLength(0);
    expect(run.cp.getConnector(2)?.availability).toBe("Inoperative");
  });

  // B01.FR.09 (#846): the reboot after a firmware update says so.
  test("2.x reboots after a firmware update with BootNotification reason FirmwareUpdate", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100, reboot: "afterInstalled" });
    await run.call("UpdateFirmware", fw2(32));
    await run.advance(2000);
    const boots = run.callsOf("BootNotification");
    expect(boots.at(-1)?.payload).toMatchObject({ reason: "FirmwareUpdate" });
  });

  test("afterInstalled: Installed, then BootNotification (L01.FR.32 b)", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { train: true, stepMs: 100, reboot: "afterInstalled" });
    await run.call("UpdateFirmware", fw2(31));
    await run.advance(2000);
    const order = run
      .frames()
      .filter(
        (f) =>
          f.dir === "CP>" &&
          f.kind === "call" &&
          (f.action === "BootNotification" ||
            f.action === "FirmwareStatusNotification"),
      )
      .map((f) => f.action);
    expect(order.slice(-2)).toEqual([
      "FirmwareStatusNotification",
      "BootNotification",
    ]);
    expect(statuses(run).at(-1)).toBe("Installed");
  });

  test("a reboot the CSMS never accepts reports no Installed", async () => {
    // The first boot is accepted: a station whose boot was Rejected does not
    // answer CSMS calls at all (1.6 §4.2), so the update could not start.
    let boots = 0;
    run = await runBehavior({
      version: "1.6",
      responders: {
        BootNotification: () => ({
          result: {
            status: ++boots === 1 ? "Accepted" : "Rejected",
            currentTime: new Date().toISOString(),
            interval: 3600,
          },
        }),
      },
    });
    select(run, { stepMs: 100, reboot: "beforeInstalled" });
    await run.call("UpdateFirmware", fw16);
    await run.advance(5000);
    expect(statuses(run)).not.toContain("Installed");
  });
});

describe("OCPP 2.x GetLog upload (#601)", () => {
  const getLog = (requestId: number) => ({
    logType: "DiagnosticsLog",
    requestId,
    log: { remoteLocation: "http://logs.example/up" },
  });

  test.each(["2.0.1"] as const)(
    "Uploading, then Uploaded after uploadMs, both with the requestId (%s)",
    async (version) => {
      run = await runBehavior({ version });
      const answer = await run.call("GetLog", getLog(40));
      expect(reply(answer)).toBe("Accepted");
      await run.advance(500);
      expect(sent(run, "LogStatusNotification")).toEqual([
        { status: "Uploading", requestId: 40 },
      ]);
      await run.advance(2000);
      expect(statuses(run, "LogStatusNotification")).toEqual([
        "Uploading",
        "Uploaded",
      ]);
      expect(
        sent(run, "LogStatusNotification").every((p) => p.requestId === 40),
      ).toBe(true);
    },
  );

  test.each(["2.0.1"] as const)(
    "a GetLog during an upload is answered AcceptedCanceled, the first upload reports AcceptedCanceled and never Uploaded (%s)",
    async (version) => {
      run = await runBehavior({ version });
      select(run, { uploadMs: 3000 }, "default.logs");
      expect(reply(await run.call("GetLog", getLog(41)))).toBe("Accepted");
      await run.advance(1000);
      expect(reply(await run.call("GetLog", getLog(42)))).toBe(
        "AcceptedCanceled",
      );
      await run.advance(10_000);
      expect(sent(run, "LogStatusNotification")).toEqual([
        { status: "Uploading", requestId: 41 },
        { status: "AcceptedCanceled", requestId: 41 },
        { status: "Uploading", requestId: 42 },
        { status: "Uploaded", requestId: 42 },
      ]);
      // Idle again: a third request is plainly accepted.
      expect(reply(await run.call("GetLog", getLog(43)))).toBe("Accepted");
    },
  );

  test("auto off keeps the station silent, as before", async () => {
    run = await runBehavior({ version: "2.0.1" });
    select(run, { auto: false }, "default.logs");
    expect(reply(await run.call("GetLog", getLog(44)))).toBe("Accepted");
    expect(reply(await run.call("GetLog", getLog(45)))).toBe("Accepted");
    await run.advance(10_000);
    expect(statuses(run, "LogStatusNotification")).toEqual([]);
  });

  test("1.6 keeps its own rule (N01.FR.11): the replaced upload is cancelled, only the new one reports Uploaded", async () => {
    run = await runBehavior({ version: "1.6" });
    expect(reply(await run.call("GetLog", getLog(46)))).toBe("Accepted");
    await run.advance(500);
    expect(reply(await run.call("GetLog", getLog(47)))).toBe(
      "AcceptedCanceled",
    );
    await run.advance(5000);
    expect(statuses(run, "LogStatusNotification")).toEqual([
      "Uploading",
      "Uploading",
      "Uploaded",
    ]);
  });
});

// The behavior harness speaks 1.6 and 2.0.1 on the wire. The two behaviors do
// not branch on 2.0.1 versus 2.1 (`isOcpp2Version`), so 2.1 is covered by
// driving them against a station stub that reports "OCPP-2.1".
describe("OCPP 2.1 (stub station)", () => {
  function stubCtx(params: JsonObject) {
    const notified: Array<[string, string, number | undefined]> = [];
    const state: Record<string, never> = {};
    const ctx = {
      params,
      state,
      stopping: false,
      now: () => Date.now(),
      sleep: () => Promise.resolve(),
      random: () => ({ int: () => 0 }),
      notify: {
        logStatus: (status: string, o?: { requestId?: number }) =>
          notified.push(["log", status, o?.requestId]),
        firmwareStatus: (status: string, o?: { requestId?: number }) =>
          notified.push(["firmware", status, o?.requestId]),
      },
    };
    return { ctx: ctx as unknown as BehaviorContext, notified };
  }
  const station = {
    ocppVersion: "OCPP-2.1",
    id: "CP-1",
    logger: { info() {}, warn() {} },
    noteLogRequest() {},
    noteFirmwareRequest() {},
    connectors: new Map(),
    configuration: { getString: () => "", applyChange() {} },
    sendSecurityEventNotification: () => Promise.resolve(),
  } as unknown as ChargePoint;

  test("GetLog: Uploading, Uploaded, and AcceptedCanceled for a replaced upload", async () => {
    const logs = logsBehavior(station);
    const { ctx, notified } = stubCtx({ uploadMs: 10, auto: true });
    const handle = logs.onCall!.GetLog.handle;
    const request = (requestId: number) => ({
      logType: "SecurityLog",
      requestId,
    });
    const first = (await handle(request(1), ctx)) as {
      response: { status: string };
      after: () => Promise<void>;
    };
    expect(first.response.status).toBe("Accepted");
    // The first upload is still running when the second request arrives.
    const waiting: Array<() => void> = [];
    (ctx as unknown as { sleep: () => Promise<void> }).sleep = () =>
      new Promise((resolve) => waiting.push(resolve));
    const running = first.after();
    const second = (await handle(request(2), ctx)) as {
      response: { status: string };
      after: () => Promise<void>;
    };
    expect(second.response.status).toBe("AcceptedCanceled");
    const replacing = second.after();
    await Promise.resolve();
    for (const resolve of waiting) resolve();
    await running;
    await replacing;
    expect(notified).toEqual([
      ["log", "Uploading", 1],
      ["log", "AcceptedCanceled", 1],
      ["log", "Uploading", 2],
      ["log", "Uploaded", 2],
    ]);
  });

  test("UpdateFirmware: the train answers AcceptedCanceled to a replacing request", async () => {
    const firmware = firmwareBehavior(station);
    const { ctx, notified } = stubCtx({
      ...firmwareBehavior(station).params!.defaults,
      train: true,
    });
    const handle = firmware.onCall!.UpdateFirmware.handle;
    const body = (requestId: number) => ({
      requestId,
      firmware: { location: "x", retrieveDateTime: "2020-01-01T00:00:00Z" },
    });
    const first = (await handle(body(1), ctx)) as {
      response: { status: string };
      after: () => Promise<void>;
    };
    expect(first.response.status).toBe("Accepted");
    await first.after();
    expect(notified.map((n) => n[1])).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
    expect(notified.every((n) => n[2] === 1)).toBe(true);
    // In flight: mark it as the train does while it runs.
    ctx.state.inFlight = true;
    const second = (await handle(body(2), ctx)) as {
      response: { status: string };
    };
    expect(second.response.status).toBe("AcceptedCanceled");
  });
});
