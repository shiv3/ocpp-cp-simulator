/* eslint-disable @typescript-eslint/no-explicit-any -- ack payloads are loosely typed in tests */
// Runs under `bun test` because it uses the `bun:sqlite` built-in.
import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "socket.io-client";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { CLIChargePointService } from "../../service";
import {
  connectTestClient,
  startTestServer,
  type TestServer,
} from "./socketHarness";

/**
 * #1133 `meterValueDecimalSeparator` and #1134 `emptyMeterValues` over the
 * control plane and `--state-db`. The comma is refused for a 2.x station, on
 * `cp.create` and on a `cp.update` that keeps it while switching to 2.x.
 */

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

const BASE = {
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "V",
  model: "M",
  ocppVersion: "OCPP-1.6J",
};

function chargePointOf(svc: CLIChargePointService | undefined): ChargePoint {
  return (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
}

function emitRpc(socket: Socket, request: unknown): Promise<any> {
  return socket.timeout(2_000).emitWithAck("rpc", request);
}

describe("meter value quirks over the control plane (#1133, #1134)", () => {
  it("cp.create sets both, status shows them, cp.update keeps them", async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const created = await emitRpc(socket, {
        method: "cp.create",
        params: {
          cpId: "CP1133",
          ...BASE,
          meterValueDecimalSeparator: ",",
          emptyMeterValues: true,
        },
      });
      expect(created.ok).toBe(true);
      const cp = chargePointOf(server.registry.get("CP1133"));
      expect(cp.meterQuirks.decimalSeparator).toBe(",");
      expect(cp.meterQuirks.emptyMeterValues).toBe(true);

      const status = await emitRpc(socket, {
        cpId: "CP1133",
        method: "status",
        params: {},
      });
      expect(status.result.config.meterValueDecimalSeparator).toBe(",");
      expect(status.result.config.emptyMeterValues).toBe(true);

      const kept = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP1133", ...BASE, vendor: "V2" },
      });
      expect(kept.ok).toBe(true);
      const updated = chargePointOf(server.registry.get("CP1133"));
      expect(updated.meterQuirks.decimalSeparator).toBe(",");
      expect(updated.meterQuirks.emptyMeterValues).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it('refuses "," for a 2.x station on cp.create and on cp.update', async () => {
    const server = await startTestServer();
    servers.push(server);
    const socket = await connectTestClient(server);
    try {
      const refused = await emitRpc(socket, {
        method: "cp.create",
        params: {
          cpId: "CP1133-v2",
          ...BASE,
          ocppVersion: "OCPP-2.0.1",
          meterValueDecimalSeparator: ",",
        },
      });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused.error)).toContain("OCPP 1.6 only");
      expect(server.registry.get("CP1133-v2")).toBeUndefined();

      expect(
        (
          await emitRpc(socket, {
            method: "cp.create",
            params: {
              cpId: "CP1133-16",
              ...BASE,
              meterValueDecimalSeparator: ",",
            },
          })
        ).ok,
      ).toBe(true);
      // The update omits the separator, so it would keep the comma.
      const update = await emitRpc(socket, {
        method: "cp.update",
        params: { cpId: "CP1133-16", ...BASE, ocppVersion: "OCPP-2.1" },
      });
      expect(update.ok).toBe(false);
      expect(JSON.stringify(update.error)).toContain("OCPP 1.6 only");
      // Refused before the old station was torn down.
      expect(chargePointOf(server.registry.get("CP1133-16")).ocppVersion).toBe(
        "OCPP-1.6J",
      );
    } finally {
      socket.disconnect();
    }
  });
});

describe("meter value quirks on --state-db (#1133, #1134)", () => {
  it("survive a restart", () => {
    const db = BunSqliteDatabase.open(":memory:");
    const registry = new CPRegistry(new EventBus(), db);
    let restored: CPRegistry | null = null;
    try {
      registry.create(
        {
          cpId: "CP1133-db",
          basicAuth: null,
          ...BASE,
          meterValueDecimalSeparator: ",",
          emptyMeterValues: true,
        },
        { seedDefault: false },
      );
      registry.shutdownAll();
      restored = new CPRegistry(new EventBus(), db);
      expect(restored.restoreFromDatabase({ connect: false })).toEqual([
        "CP1133-db",
      ]);
      const cp = chargePointOf(restored.get("CP1133-db"));
      expect(cp.meterQuirks.decimalSeparator).toBe(",");
      expect(cp.meterQuirks.emptyMeterValues).toBe(true);
    } finally {
      registry.shutdownAll();
      restored?.shutdownAll();
      db.close();
    }
  });
});
