import { afterEach, describe, expect, it } from "bun:test";
import {
  type JsonModeSession,
  startJsonMode,
  startStubCsms,
  type StubCsms,
  waitForPayloads,
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

    // Commands with only optional extras on top of the TCK's parameters. The
    // optional ones are sent with values that are NOT the defaults and read
    // back off the wire: JSON mode ignores keys it does not know, so a
    // renamed parameter would otherwise still answer ok (#346).
    expect(await cp.request("authorize", { tagId: "TAG1" })).toEqual({
      id: "t3",
      ok: true,
    });
    expect(await cp.request("heartbeat")).toEqual({ id: "t4", ok: true });
    expect(
      await cp.request("start_transaction", { connector: 1, tagId: "TAG1" }),
    ).toEqual({ id: "t5", ok: true, data: { started: true } });
    // The TCK's J_xx readings name Sample.Clock (core-201.ts); the default is
    // Sample.Periodic.
    expect(
      await cp.request("send_meter_value", {
        connector: 1,
        context: "Sample.Clock",
      }),
    ).toEqual({ id: "t6", ok: true });
    const meter = await waitForPayloads(csms, "MeterValues", 1);
    expect(meter[0].connectorId).toBe(1);
    expect(
      meter[0].meterValue[0].sampledValue.map(
        (v: { context?: string }) => v.context,
      ),
    ).toContain("Sample.Clock");
    // `Local` is the default (and may be omitted on the wire in 1.6).
    expect(
      await cp.request("stop_transaction", {
        connector: 1,
        reason: "EVDisconnected",
      }),
    ).toEqual({ id: "t7", ok: true });
    const stop = await waitForPayloads(csms, "StopTransaction", 1);
    expect(stop[0].reason).toBe("EVDisconnected");

    // EOF on stdin => exit 0.
    expect(await cp.end()).toBe(0);
  }, 60_000);

  it("follows the TCK's template-once flow: disabled copy, same id, run by that id", async () => {
    // template-once.ts: BEFORE `connect` (a loaded template starts at once on
    // a station that is already Available), on one connector, with the id the
    // template minted: load the template, read the instance back, remove it,
    // load the same definition again with enabled:false so the auto-start
    // skips it, connect, then run_scenario on the ORIGINAL id.
    // `<templateId>-c<connector>` (#338) is what it passes around.
    csms = startStubCsms();
    cp = startJsonMode(csms.url);
    const loaded = ok(
      await cp.request("load_scenario_template", {
        connector: 1,
        templateId: "cert16-tc001-cold-boot",
      }),
    ).data as { scenarioId: string };
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

    const reloaded = ok(
      await cp.request("load_scenario", {
        connector: 1,
        scenario: { ...scenario, enabled: false },
      }),
    ).data as { scenarioId: string };
    // The id is kept: the TCK runs the scenario by the id it got from the
    // template, not by the one load_scenario answers.
    expect(reloaded.scenarioId).toBe(loaded.scenarioId);

    const boots = () =>
      cp!.stdout.filter((l) => l.includes('"event":"boot_notification"'))
        .length;
    const startedEvents = () =>
      cp!.stdout.filter((l) => l.includes('"event":"scenario_started"')).length;

    // enabled:false stops the auto-start: the station boots and reaches
    // Available, and the scenario stays parked until run_scenario.
    ok(await cp.request("connect"));
    await cp.waitForLine(() => boots() >= 1);
    await Bun.sleep(1000);
    expect(startedEvents()).toBe(0);

    expect(
      await cp.request("run_scenario", {
        connector: 1,
        scenarioId: loaded.scenarioId,
      }),
    ).toMatchObject({ ok: true });
    const started = JSON.parse(
      await cp.waitForLine((l) => l.includes('"event":"scenario_started"')),
    ) as Record<string, unknown>;
    expect(Object.keys(started).sort()).toEqual(["data", "event", "timestamp"]);
    expect(Number.isNaN(Date.parse(String(started.timestamp)))).toBe(false);

    // run_scenario_template with `once` (#352) returns `{scenarioId}`, runs
    // the scenario now and does not re-arm it on the next connect.
    const before = startedEvents();
    const ran = ok(
      await cp.request("run_scenario_template", {
        connector: 2,
        templateId: "cert16-tc001-cold-boot",
        once: true,
      }),
    ).data as { scenarioId: string };
    expect(typeof ran.scenarioId).toBe("string");
    await cp.waitForLine(() => startedEvents() > before);
    const afterOnce = startedEvents();
    const bootsBefore = boots();
    ok(await cp.request("disconnect"));
    ok(await cp.request("connect"));
    await cp.waitForLine(() => boots() > bootsBefore);
    await Bun.sleep(1000);
    expect(startedEvents()).toBe(afterOnce);

    expect(await cp.end()).toBe(0);
  }, 60_000);

  it("accepts transaction_event on an OCPP 2.0.1 charge point", async () => {
    csms = startStubCsms("ocpp2.0.1");
    cp = startJsonMode(csms.url, "OCPP-2.0.1");
    expect(await cp.request("connect")).toEqual({ id: "t1", ok: true });
    await cp.waitForLine((l) => l.includes('"event":"boot_notification"'));
    // Non-default values, read back off the wire (defaults: Authorized,
    // Charging, Sample.Periodic, Local, StopAuthorized).
    expect(
      await cp.request("start_transaction", {
        connector: 1,
        tagId: "TAG1",
        triggerReason: "CablePluggedIn",
        chargingState: "EVConnected",
      }),
    ).toEqual({ id: "t2", ok: true, data: { started: true } });
    // No wait between the two (#813): the reply above means the transaction
    // exists.
    expect(
      await cp.request("transaction_event", {
        connector: 1,
        triggerReason: "MeterValueClock",
        meterValues: true,
        context: "Sample.Clock",
      }),
    ).toEqual({ id: "t3", ok: true });
    expect(
      await cp.request("stop_transaction", {
        connector: 1,
        reason: "EVDisconnected",
        triggerReason: "EVDeparted",
      }),
    ).toEqual({ id: "t4", ok: true });
    // Start, update, end.
    const events = await waitForPayloads(csms, "TransactionEvent", 3);
    expect(events.map((e) => e.eventType)).toEqual([
      "Started",
      "Updated",
      "Ended",
    ]);
    expect(events[0].triggerReason).toBe("CablePluggedIn");
    expect(events[0].transactionInfo.chargingState).toBe("EVConnected");
    expect(events[1].triggerReason).toBe("MeterValueClock");
    expect(
      events[1].meterValue[0].sampledValue.map(
        (v: { context?: string }) => v.context,
      ),
    ).toContain("Sample.Clock");
    expect(events[2].triggerReason).toBe("EVDeparted");
    expect(events[2].transactionInfo.stoppedReason).toBe("EVDisconnected");
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
