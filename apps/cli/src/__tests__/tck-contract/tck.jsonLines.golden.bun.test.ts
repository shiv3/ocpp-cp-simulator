import { afterEach, describe, expect, it } from "bun:test";
import {
  type JsonModeSession,
  startJsonMode,
  startStubCsms,
  type StubCsms,
} from "./tckHarness";

// GOLDEN TEST FOR AN EXTERNAL CONSUMER (#346 item 1).
//
// open-ocpp-tck (github.com/juherr/open-ocpp-tck) runs this CLI as a charge
// point and drives it over stdin JSON Lines. This file pins the part of that
// surface the TCK uses: the command names, the parameter shapes and the
// response envelope `{id, ok, data | error}`, and exit code 0 when stdin
// reaches EOF. If it fails, you have changed what a published consumer relies
// on. Do not "update the golden" to make it pass:
//   - add new parameters as optional, never rename or remove a parameter or
//     command (add an alias and keep the old name for a period);
//   - then document the change in docs/entities/cli.md ("TCK contract").
// What the TCK uses is listed there, with the wire side of the contract.

let csms: StubCsms | undefined;
let cp: JsonModeSession | undefined;

afterEach(async () => {
  cp?.kill();
  await csms?.stop();
  cp = undefined;
  csms = undefined;
});

function ok(res: Record<string, unknown>): Record<string, unknown> {
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

describe("TCK contract: JSON Lines transcript (#346)", () => {
  it("answers every command the TCK sends, with the documented envelope", async () => {
    csms = startStubCsms();
    cp = startJsonMode(csms.url);

    // connect -> bare success: `data` is absent, not null.
    const connect = await cp.request("connect");
    expect(connect).toEqual({ id: "t1", ok: true });
    await cp.waitForLine((l) => l.includes('"event":"boot_notification"'));

    // status -> the charge point snapshot.
    const status = ok(await cp.request("status")).data as {
      id: string;
      status: string;
      connectors: Array<{ id: number; status: string }>;
    };
    expect(status.id).toBe("TCKCP");
    expect(status.connectors.map((c) => c.id)).toEqual([1, 2]);
    expect(typeof status.status).toBe("string");

    // Commands with only optional extras on top of the TCK's parameters.
    expect(await cp.request("authorize", { tagId: "TAG1" })).toEqual({
      id: "t3",
      ok: true,
    });
    expect(await cp.request("heartbeat")).toEqual({ id: "t4", ok: true });
    expect(
      await cp.request("start_transaction", { connector: 1, tagId: "TAG1" }),
    ).toEqual({ id: "t5", ok: true });
    expect(
      await cp.request("send_meter_value", {
        connector: 1,
        context: "Sample.Periodic",
      }),
    ).toEqual({ id: "t6", ok: true });
    expect(
      await cp.request("stop_transaction", { connector: 1, reason: "Local" }),
    ).toEqual({ id: "t7", ok: true });

    // Scenario commands: ids come back as `{scenarioId}`, removal as
    // `{removed}`, and get_scenario returns the stored definition.
    const loaded = ok(
      await cp.request("load_scenario_template", {
        connector: 1,
        templateId: "cert16-tc001-cold-boot",
      }),
    ).data as { scenarioId: string };
    // `<templateId>-c<connector>` (#338): the TCK passes it back verbatim.
    expect(loaded.scenarioId).toBe("cert16-tc001-cold-boot-c1");

    const scenario = ok(
      await cp.request("get_scenario", {
        connector: 1,
        scenarioId: loaded.scenarioId,
      }),
    ).data as { id: string; nodes: unknown[]; edges: unknown[] };
    expect(scenario.id).toBe(loaded.scenarioId);
    expect(Array.isArray(scenario.nodes)).toBe(true);
    expect(Array.isArray(scenario.edges)).toBe(true);

    expect(
      ok(
        await cp.request("remove_scenario", {
          connector: 1,
          scenarioId: loaded.scenarioId,
        }),
      ).data,
    ).toEqual({ removed: true });

    // The TCK's patch flow: take the template's definition, switch it off
    // with enabled:false (so it does not start by itself) and load it back
    // as an inline `scenario`; then run_scenario on it.
    const inlineLoaded = ok(
      await cp.request("load_scenario", {
        connector: 2,
        scenario: { ...scenario, enabled: false },
      }),
    ).data as { scenarioId: string };
    expect(typeof inlineLoaded.scenarioId).toBe("string");
    expect(
      await cp.request("run_scenario", {
        connector: 2,
        scenarioId: inlineLoaded.scenarioId,
      }),
    ).toMatchObject({ ok: true });

    // run_scenario_template with `once` (#352) returns `{scenarioId}`.
    const ran = ok(
      await cp.request("run_scenario_template", {
        connector: 1,
        templateId: "cert16-tc001-cold-boot",
        once: true,
      }),
    ).data as { scenarioId: string };
    expect(typeof ran.scenarioId).toBe("string");

    // Events share the stdout stream: {event, data, timestamp}.
    const started = JSON.parse(
      await cp.waitForLine((l) => l.includes('"event":"scenario_started"')),
    ) as Record<string, unknown>;
    expect(Object.keys(started).sort()).toEqual(["data", "event", "timestamp"]);
    expect(Number.isNaN(Date.parse(String(started.timestamp)))).toBe(false);

    // EOF on stdin => exit 0.
    expect(await cp.end()).toBe(0);
  }, 60_000);

  it("accepts transaction_event on an OCPP 2.0.1 charge point", async () => {
    csms = startStubCsms("ocpp2.0.1");
    cp = startJsonMode(csms.url, "OCPP-2.0.1");
    expect(await cp.request("connect")).toEqual({ id: "t1", ok: true });
    await cp.waitForLine((l) => l.includes('"event":"boot_notification"'));
    expect(
      await cp.request("start_transaction", {
        connector: 1,
        tagId: "TAG1",
        triggerReason: "Authorized",
        chargingState: "Charging",
      }),
    ).toEqual({ id: "t2", ok: true });
    expect(
      await cp.request("transaction_event", {
        connector: 1,
        triggerReason: "MeterValuePeriodic",
        meterValues: true,
        context: "Sample.Periodic",
      }),
    ).toEqual({ id: "t3", ok: true });
    expect(
      await cp.request("stop_transaction", {
        connector: 1,
        reason: "Local",
        triggerReason: "StopAuthorized",
      }),
    ).toEqual({ id: "t4", ok: true });
    // The response can overtake the frame on its way to the CSMS: wait for
    // the third TransactionEvent (start, update, end) instead of counting once.
    const count = () =>
      csms!.frames.filter(
        (f) => (JSON.parse(f) as unknown[])[2] === "TransactionEvent",
      ).length;
    for (let i = 0; i < 100 && count() < 3; i++) await Bun.sleep(50);
    expect(count()).toBe(3);
    expect(await cp.end()).toBe(0);
  }, 30_000);

  it("reports failures as {id, ok:false, error} and unknown commands too", async () => {
    csms = startStubCsms();
    cp = startJsonMode(csms.url);
    const missing = await cp.request("authorize", {});
    expect(missing.ok).toBe(false);
    expect(typeof missing.error).toBe("string");
    expect(Object.keys(missing).sort()).toEqual(["error", "id", "ok"]);
    const unknown = await cp.request("no_such_command");
    expect(unknown.ok).toBe(false);
    expect(unknown.id).toBe("t2");
    expect(await cp.end()).toBe(0);
  }, 30_000);
});
