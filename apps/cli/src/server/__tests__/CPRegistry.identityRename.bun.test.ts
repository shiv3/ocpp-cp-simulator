// Runs under `bun test` because it uses `bun:sqlite` and `Bun.serve`.
import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";

import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { startMockCsms } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";
import type { MockCsms } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";

/** #924: rename a charge point through ChangeConfiguration, applied at reboot. */
const registries: CPRegistry[] = [];
const csmsList: MockCsms[] = [];
const databases: BunSqliteDatabase[] = [];

afterEach(async () => {
  while (registries.length > 0) registries.pop()?.shutdownAll();
  while (databases.length > 0) databases.pop()?.close();
  while (csmsList.length > 0) await csmsList.pop()?.stop();
});

function chargePointOf(registry: CPRegistry, cpId: string): ChargePoint {
  const svc = registry.get(cpId);
  if (!svc) throw new Error(`no charge point ${cpId}`);
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

const INIT = {
  connectors: 1,
  vendor: "V",
  model: "M",
  basicAuth: null,
} as const;

let nextId = 1;
/** One CSMS call, answered by the station. */
async function call(
  csms: MockCsms,
  action: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const id = `csms-${nextId++}`;
  csms.send([2, id, action, payload]);
  const frame = await csms.waitForFrame((f) => f[0] === 3 && f[1] === id);
  return frame[2] as Record<string, unknown>;
}

async function acceptBoot(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-11-14T00:00:00.000Z",
    interval: 300,
  });
}

const change = (csms: MockCsms, key: string, value: string) =>
  call(csms, "ChangeConfiguration", { key, value });

const configValue = async (csms: MockCsms, key: string) => {
  const res = await call(csms, "GetConfiguration", { key: [key] });
  return (res.configurationKey as Array<{ key: string; value?: string }>)[0]
    ?.value;
};

describe("ChargePointIdentity rename (#924)", () => {
  it("is Rejected for the invalid, the taken and without a host; Accepted for the active one", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const registry = new CPRegistry(new EventBus(), null);
    registries.push(registry);
    registry.create(
      { cpId: "A-1", wsUrl: csms.url, ...INIT },
      { seedDefault: false },
    );
    registry.create(
      { cpId: "B-1", wsUrl: "ws://127.0.0.1:9/", ...INIT },
      { seedDefault: false },
    );
    await registry
      .get("A-1")
      ?.connect()
      .catch(() => undefined);
    await acceptBoot(csms);

    for (const bad of ["", "a/b", "a b", "a?b", "a#b", "x".repeat(49)]) {
      const res = await change(csms, "ChargePointIdentity", bad);
      expect(res.status).toBe("Rejected");
    }
    // Used by another box of this simulator.
    expect((await change(csms, "ChargePointIdentity", "B-1")).status).toBe(
      "Rejected",
    );
    // Same as the active identity: Accepted, nothing pending.
    expect((await change(csms, "ChargePointIdentity", "A-1")).status).toBe(
      "Accepted",
    );
    expect(chargePointOf(registry, "A-1").pendingIdentity).toBeNull();
    expect(await configValue(csms, "ChargePointIdentity")).toBe("A-1");
    expect([...registry.list()].sort()).toEqual(["A-1", "B-1"]);
  });

  it("answers RebootRequired, keeps the old identity until Reset, then reconnects under the new one with state kept", async () => {
    const csms = startMockCsms();
    csmsList.push(csms);
    const db = BunSqliteDatabase.open(":memory:");
    databases.push(db);
    const registry = new CPRegistry(new EventBus(), db);
    registries.push(registry);
    registry.create(
      { cpId: "OLD-ID", wsUrl: csms.url, ...INIT },
      { seedDefault: false },
    );
    registry
      .get("OLD-ID")
      ?.connect()
      .catch(() => undefined);
    await acceptBoot(csms);
    expect(csms.requestPaths).toEqual(["/OLD-ID"]);

    expect((await change(csms, "HeartbeatInterval", "123")).status).toBe(
      "Accepted",
    );
    expect((await change(csms, "ChargePointIdentity", "MID_ID")).status).toBe(
      "RebootRequired",
    );
    // Last write wins.
    expect((await change(csms, "ChargePointIdentity", "NEW_ID")).status).toBe(
      "RebootRequired",
    );
    // Still connected as the old identity, which GetConfiguration reports.
    expect(registry.list()).toEqual(["OLD-ID"]);
    expect(await configValue(csms, "ChargePointIdentity")).toBe("OLD-ID");
    expect(csms.requestPaths).toEqual(["/OLD-ID"]);
    // The pending value is stored with the charge point's rows.
    expect(
      db.get<{ value: string }>(
        "SELECT value FROM configuration WHERE cp_id = 'OLD-ID' AND key = ?",
        ["$pendingChargePointIdentity"],
      )?.value,
    ).toBe("NEW_ID");

    const bootsBefore = csms.received.filter(
      (f) => f[2] === "BootNotification",
    ).length;
    expect((await call(csms, "Reset", { type: "Soft" })).status).toBe(
      "Accepted",
    );
    await csms.waitForFrame(
      (f) =>
        f[2] === "BootNotification" &&
        csms.received.filter((x) => x[2] === "BootNotification").length >
          bootsBefore,
      5000,
    );
    expect(csms.requestPaths).toEqual(["/OLD-ID", "/NEW_ID"]);
    await acceptBoot(csms).catch(() => undefined);

    expect(registry.list()).toEqual(["NEW_ID"]);
    const configuration = chargePointOf(registry, "NEW_ID").configuration;
    expect(configuration.getInteger("HeartbeatInterval")).toBe(123);
    expect(configuration.getString("ChargePointIdentity")).toBe("NEW_ID");
    // Every cp_id row moved; none is left under the old identity and the
    // pending marker is gone.
    for (const table of ["charge_points", "configuration"]) {
      expect(
        db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE cp_id = 'OLD-ID'`,
        )?.n,
      ).toBe(0);
    }
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM configuration WHERE cp_id = 'NEW_ID' AND key = ?",
        ["$pendingChargePointIdentity"],
      )?.n,
    ).toBe(0);

    // A restart brings the box back under the new identity, config kept.
    registry.shutdownAll();
    const restored = new CPRegistry(new EventBus(), db);
    registries.push(restored);
    expect(restored.restoreFromDatabase({ connect: false })).toEqual([
      "NEW_ID",
    ]);
    expect(
      chargePointOf(restored, "NEW_ID").configuration.getInteger(
        "HeartbeatInterval",
      ),
    ).toBe(123);
  });

  it("a simulator restart applies a pending identity and moves scenarios, runs and sessions", () => {
    const db = BunSqliteDatabase.open(":memory:");
    databases.push(db);
    const registry = new CPRegistry(new EventBus(), db);
    registries.push(registry);
    registry.create(
      { cpId: "R-OLD", wsUrl: "ws://127.0.0.1:9/", ...INIT },
      { seedDefault: true },
    );
    const scenariosBefore = registry.get("R-OLD")?.snapshotScenarios().length;
    expect(scenariosBefore).toBeGreaterThan(0);
    registry.get("R-OLD");
    expect(
      chargePointOf(registry, "R-OLD").configuration.applyChange(
        "ChargePointIdentity",
        "R-NEW",
      ),
    ).toBe("RebootRequired");
    db.run(
      "INSERT INTO logs (cp_id, timestamp, level, log_type, message) VALUES ('R-OLD', 't', 'INFO', 'GENERAL', 'm')",
    );
    db.run(
      "INSERT INTO scenario_runs (cp_id, run_id, connector_id, scenario_id, started_at, ended_at, execution_state, verdict, summary_json, report_json) VALUES ('R-OLD', 'r1', 1, 's', 't', 't', 'done', 'pass', '{\"cpId\":\"R-OLD\"}', '{\"cpId\":\"R-OLD\"}')",
    );
    db.run(
      "INSERT INTO charging_sessions (cp_id, session_id, connector_id, started_at, outcome, session_json) VALUES ('R-OLD', 'x1', 1, 't', 'completed', '{\"cpId\":\"R-OLD\"}')",
    );
    registry.shutdownAll();

    const restored = new CPRegistry(new EventBus(), db);
    registries.push(restored);
    expect(restored.restoreFromDatabase({ connect: false })).toEqual(["R-NEW"]);
    expect(restored.get("R-NEW")?.snapshotScenarios().length).toBe(
      scenariosBefore,
    );
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM logs WHERE cp_id = 'R-NEW'",
      )?.n,
    ).toBeGreaterThan(0);
    expect(
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM logs WHERE cp_id = 'R-OLD'",
      )?.n,
    ).toBe(0);
  });

  it("a pending identity taken meanwhile is dropped at restart; the box keeps its identity", () => {
    const db = BunSqliteDatabase.open(":memory:");
    databases.push(db);
    const registry = new CPRegistry(new EventBus(), db);
    registries.push(registry);
    registry.create(
      { cpId: "T-1", wsUrl: "ws://127.0.0.1:9/", ...INIT },
      { seedDefault: false },
    );
    chargePointOf(registry, "T-1").configuration.applyChange(
      "ChargePointIdentity",
      "T-2",
    );
    // Another box takes the id before the reboot (checked again at reboot).
    db.run(
      "INSERT INTO charge_points (cp_id, ws_url, connectors, vendor, model, created_at) VALUES ('T-2', 'ws://127.0.0.1:9/', 1, 'V', 'M', 'x')",
    );
    registry.shutdownAll();
    const restored = new CPRegistry(new EventBus(), db);
    registries.push(restored);
    expect(restored.restoreFromDatabase({ connect: false }).sort()).toEqual([
      "T-1",
      "T-2",
    ]);
    expect(chargePointOf(restored, "T-1").pendingIdentity).toBeNull();
  });
});
