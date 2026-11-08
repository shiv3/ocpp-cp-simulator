import { describe, expect, it } from "vitest";

import { parseCreateBody } from "../httpServer";
import { createParamsSchema } from "@ocpp-cp-simulator/contracts/index";
import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps } from "../socketServer";
import { BunSqliteDatabase } from "@ocpp-cp-simulator/core/cp/infrastructure/persistence/BunSqliteDatabase";
import { createChargePoint } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createChargePoint";
import { DefaultBootNotification } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { UnsupportedWsOptionError } from "@ocpp-cp-simulator/core/cp/shared/WsClientOptions";

// #611 on Bun: handshakeTimeoutMs, perMessageDeflate and proxy are honoured;
// maxPayloadBytes and localAddress are not and are refused, never ignored.

const BASE = { cpId: "CP-611", connectors: 1, wsUrl: "ws://a/ocpp/" };
const SUPPORTED = {
  handshakeTimeoutMs: 5000,
  perMessageDeflate: false,
  proxy: "http://proxy.example:3128",
} as const;

describe("transport.ws on the control plane (#611)", () => {
  it("is parsed, and refused for a typo, a bad value or a SOAP version", () => {
    expect(
      parseCreateBody({ ...BASE, transport: { ws: SUPPORTED } }).transport,
    ).toEqual({ ws: SUPPORTED });
    const bad = (ws: unknown) =>
      expect(() => parseCreateBody({ ...BASE, transport: { ws } })).toThrow(
        /transport is invalid/,
      );
    bad({ handshakeTimeout: 1 });
    bad({ handshakeTimeoutMs: 0 });
    bad({ maxPayloadBytes: 1.5 });
    bad({ proxy: "socks5://p:1" });
    bad({ localAddress: "" });
    expect(() =>
      parseCreateBody({
        ...BASE,
        ocppVersion: "OCPP-1.6S",
        soapCallbackUrl: "http://sim/ocpp/soap/CP-611/ChargePointService",
        transport: { ws: SUPPORTED },
      }),
    ).toThrow(/SOAP versions have none/);
  });

  it("is expressible through the cp.create schema", () => {
    expect(
      createParamsSchema.safeParse({ ...BASE, transport: { ws: SUPPORTED } })
        .success,
    ).toBe(true);
    expect(
      createParamsSchema.safeParse({
        ...BASE,
        transport: { ws: { proxy: "ftp://x" } },
      }).success,
    ).toBe(false);
  });

  it("a charge point takes the supported options", () => {
    const cp = createChargePoint(
      "CP-611",
      DefaultBootNotification,
      1,
      "ws://a/ocpp/",
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.6J",
      { ws: SUPPORTED },
    );
    expect(cp["_webSocket"]!.wsClientOptions).toEqual(SUPPORTED);
    cp["_webSocket"]!.dispose();
  });

  it("refuses an option Bun would ignore, naming it", async () => {
    expect(() =>
      createChargePoint(
        "CP-611",
        DefaultBootNotification,
        1,
        "ws://a/ocpp/",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        { ws: { maxPayloadBytes: 1024 } },
      ),
    ).toThrow(UnsupportedWsOptionError);

    const registry = new CPRegistry(new EventBus());
    const service = createRuntimeDeps({
      registry,
      bus: new EventBus(),
    }).chargePointService;
    try {
      await expect(
        service.createChargePoint(
          parseCreateBody({
            ...BASE,
            transport: { ws: { localAddress: "10.0.0.5" } },
          }),
        ),
      ).rejects.toThrow(/"localAddress" is not supported on bun/);
      expect(registry.get("CP-611")).toBeUndefined();
    } finally {
      registry.shutdownAll();
    }
  });

  it("reaches the transport and survives a restart", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      first.create(
        {
          cpId: "CP-WS",
          wsUrl: "ws://a/ocpp/",
          connectors: 1,
          vendor: "V",
          model: "M",
          basicAuth: null,
          transport: { ws: SUPPORTED, reconnect: { maxAttempts: 2 } },
        },
        { seedDefault: false },
      );
      expect(
        first.get("CP-WS")!["_chargePoint"]["_webSocket"]!.wsClientOptions,
      ).toEqual(SUPPORTED);
      first.shutdownAll();

      const second = new CPRegistry(new EventBus(), db);
      try {
        second.restoreFromDatabase();
        expect(second.get("CP-WS")?.getInit().transport).toEqual({
          ws: SUPPORTED,
          reconnect: { maxAttempts: 2 },
        });
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });

  it("skips, and keeps, a stored row whose option this runtime cannot honour", () => {
    const db = BunSqliteDatabase.open(":memory:");
    try {
      const first = new CPRegistry(new EventBus(), db);
      for (const cpId of ["CP-OK", "CP-NODE"]) {
        first.create(
          {
            cpId,
            wsUrl: "ws://a/ocpp/",
            connectors: 1,
            vendor: "V",
            model: "M",
            basicAuth: null,
          },
          { seedDefault: false },
        );
      }
      first.shutdownAll();
      // A row written by a Node daemon.
      db.run(
        "UPDATE charge_points SET transport_options = ? WHERE cp_id = 'CP-NODE'",
        ['{"ws":{"localAddress":"10.0.0.5"}}'],
      );

      const second = new CPRegistry(new EventBus(), db);
      try {
        expect(second.restoreFromDatabase()).toEqual(["CP-OK"]);
        expect(second.get("CP-NODE")).toBeUndefined();
        expect(
          db.all("SELECT cp_id FROM charge_points WHERE cp_id = 'CP-NODE'"),
        ).toHaveLength(1);
      } finally {
        second.shutdownAll();
      }
    } finally {
      db.close();
    }
  });
});
