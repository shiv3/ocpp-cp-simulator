import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChargePoint } from "../ChargePoint";
import { createChargePoint } from "../../../infrastructure/charge-point/createChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import {
  leafForCsr,
  selfSignedRoot,
} from "../../security/__tests__/certificateFixtures";
import { resolveNetworkSimConfig } from "../../../infrastructure/transport/network-sim";
import type { OcppTlsOptions } from "../../../infrastructure/transport/wsUrlWithBasic";

/**
 * #564 A02.FR.08: a renewed Charging Station certificate is handed to the
 * transport when the chain is stored, not when the CertificateSigned answer
 * is written. An answer held by network simulation and dropped by a manual
 * disconnect therefore does not lose the switch.
 */

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly frames: unknown[][] = [];

  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as unknown[]);
  }
  ping(): void {}

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(frame: unknown[]): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({
      code: 1000,
      reason: "",
      wasClean: true,
    } as CloseEvent);
  }
}

const attempts: Array<OcppTlsOptions | undefined> = [];
const sockets: FakeWebSocket[] = [];

vi.mock("../../../infrastructure/transport/wsUrlWithBasic", async (orig) => ({
  ...(await orig<
    typeof import("../../../infrastructure/transport/wsUrlWithBasic")
  >()),
  openOcppWebSocket: (options: {
    tls?: OcppTlsOptions;
    onopen?: () => void;
    onclose?: (ev: CloseEvent) => void;
    onmessage?: (ev: MessageEvent) => void;
    onConnectOptions?: (o: unknown) => void;
  }) => {
    attempts.push(options.tls);
    options.onConnectOptions?.({
      url: "wss://csms.example/ocpp/CP",
      protocols: [],
      headers: {},
      tls: options.tls,
      useNodeWsFallback: false,
    });
    const ws = new FakeWebSocket();
    ws.onopen = options.onopen ?? null;
    ws.onclose = options.onclose ?? null;
    ws.onmessage = options.onmessage ?? null;
    sockets.push(ws);
    return ws;
  },
  probeUpgradeRefusal: () => Promise.resolve(null),
}));

const CONFIGURED_CERT = "CONFIGURED CERT";

/** The store's key export is real async crypto, which fake timers do not
 *  advance: yields to the event loop until `done`. */
async function until(done: () => boolean): Promise<void> {
  const started = performance.now();
  while (!done() && performance.now() - started < 10_000) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

function station(version: string): ChargePoint {
  const cp = createChargePoint(
    "CP-DROPPED",
    DefaultBootNotification,
    1,
    "wss://csms.example/ocpp",
    null,
    null,
    null,
    {},
    [],
    version,
    {},
    3,
    undefined,
    undefined,
    { cert: CONFIGURED_CERT, key: "CONFIGURED KEY" },
  );
  cp.events.on("error", () => undefined);
  return cp;
}

function transportOf(cp: ChargePoint): object {
  return (cp as unknown as { _webSocket: object })._webSocket;
}

afterEach(() => {
  vi.useRealTimers();
  attempts.length = 0;
  sockets.length = 0;
});

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "a CertificateSigned answer dropped before it is written (#564, %s)",
  (version) => {
    async function signedChain(cp: ChargePoint) {
      const root = await selfSignedRoot("01", "Root");
      const csr = await cp.certificateStore.generateNewCsr(cp.id, "CPO");
      return leafForCsr("02", csr, root);
    }

    it("presents the renewed certificate at the next connection, with one connection", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const cp = station(version);
      cp.connect();
      sockets[0].open();
      const chain = await signedChain(cp);
      // Upstream latency holds every frame the station writes.
      cp.setNetworkSimConfig(
        resolveNetworkSimConfig(
          {
            enabled: true,
            seed: 1,
            rules: {
              hold: {
                type: "latency",
                direction: "upstream",
                delayMs: 60_000,
              },
            },
          },
          null,
          "CP-DROPPED",
        ),
      );

      sockets[0].receive([
        2,
        "signed-1",
        "CertificateSigned",
        {
          certificateChain: chain,
          certificateType: "ChargingStationCertificate",
        },
      ]);
      // Stored and handed to the transport, the answer still held.
      await until(() => cp.certificateStore.hasTlsClientIdentity());
      await until(
        () =>
          (
            transportOf(cp) as unknown as {
              _renewedClientCertificate: unknown;
            }
          )._renewedClientCertificate !== null,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets[0].frames.some((frame) => frame[1] === "signed-1")).toBe(
        false,
      );

      cp.disconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      cp.connect();
      sockets[1].open();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(sockets).toHaveLength(2);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.cert).toBe(CONFIGURED_CERT);
      expect(attempts[1]?.cert).toBe(`${chain}\n`);
      cp.dispose();
    });

    it("still reconnects an open connection once the answer is written", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const cp = station(version);
      cp.connect();
      sockets[0].open();
      const chain = await signedChain(cp);

      sockets[0].receive([
        2,
        "signed-1",
        "CertificateSigned",
        {
          certificateChain: chain,
          certificateType: "ChargingStationCertificate",
        },
      ]);
      await until(() =>
        sockets[0].frames.some((frame) => frame[1] === "signed-1"),
      );
      // The switch reads the store again after the answer: real crypto.
      await until(() => sockets.length === 2);
      await vi.advanceTimersByTimeAsync(5_000);

      // The answer went out on the connection that asked, and only then
      // did the station reconnect, once, with the renewed certificate.
      const answered = sockets[0].frames.some(
        (frame) => frame[0] === 3 && frame[1] === "signed-1",
      );
      expect(answered).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(attempts[1]?.cert).toBe(`${chain}\n`);
      cp.dispose();
    });
  },
);
