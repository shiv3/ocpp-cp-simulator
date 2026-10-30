/* eslint-disable @typescript-eslint/no-explicit-any -- test ack payloads */
// Runs under `bun test`: a real daemon, driven over Socket.IO, MCP, the
// remote service and JSON-Lines mode, against a mock CSMS.
import { afterEach, describe, expect, it } from "bun:test";

import { startServer, type RunningServer } from "../startServer";
import { connectTestClient } from "./socketHarness";
import {
  startMockCsms,
  type MockCsms,
} from "../../../cp/infrastructure/transport/__tests__/mockCsms";
import { RemoteChargePointService } from "../../../data/remote/RemoteChargePointService";
import { handleJsonCommand } from "../../jsonMode";

/**
 * #393: `send_raw_frame` end to end on every surface that exposes it. Each
 * one ends in the same `ChargePoint.sendRawFrame`, so a CALLERROR the CSMS
 * sends for the frame comes back as the result.
 */

const BASE_OPTIONS = {
  httpHost: "127.0.0.1",
  pidPath: null,
  bootstrap: null,
  soapPath: "/ocpp/soap",
  autoConnect: false,
  startupScenario: null,
  cors: { kind: "any" } as const,
  staticDir: null,
  webConsolePort: null,
  healthPath: "/v1/healthz",
  webConsoleBasicAuth: null,
  insecureTlsKeyPerms: false,
  stateDb: null,
};

const CP = "CP-RAW-RPC";

/** Answers each raw frame (`raw-…` id) with a CALLERROR, every other CALL
 *  with an empty CALLRESULT, and BootNotification with Accepted. */
function answerCsms(csms: MockCsms): () => void {
  const answered = new Set<string>();
  const tick = setInterval(() => {
    for (const frame of csms.received) {
      const id = frame[1];
      if (frame[0] !== 2 || typeof id !== "string" || answered.has(id)) {
        continue;
      }
      answered.add(id);
      if (id.startsWith("raw-")) {
        csms.send([4, id, "FormationViolation", "malformed", {}]);
      } else if (frame[2] === "BootNotification") {
        csms.replyCallResult(id, {
          status: "Accepted",
          currentTime: "2026-10-30T00:00:00.000Z",
          interval: 300,
        });
      } else {
        csms.replyCallResult(id, {});
      }
    }
  }, 5);
  return () => clearInterval(tick);
}

describe("send_raw_frame over the daemon's surfaces (#393)", () => {
  const cleanups: Array<() => unknown> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function daemonWithConnectedCp() {
    const csms = startMockCsms();
    cleanups.push(() => csms.stop());
    cleanups.push(answerCsms(csms));
    const running: RunningServer = await startServer({
      ...BASE_OPTIONS,
      httpPort: 0,
    });
    cleanups.push(() => running.stop());
    const base = `http://127.0.0.1:${running.httpPort}`;
    const socket = await connectTestClient(base);
    cleanups.push(() => socket.disconnect());
    const rpc = (
      method: string,
      params: unknown,
      cpId?: string,
    ): Promise<any> =>
      new Promise((resolve) =>
        socket.emit(
          "rpc",
          { ...(cpId ? { cpId } : {}), method, params },
          resolve,
        ),
      );
    const created = await rpc("cp.create", {
      cpId: CP,
      wsUrl: csms.url,
      connectors: 1,
      vendor: "V",
      model: "M",
      ocppVersion: "OCPP-1.6J",
    });
    expect(created.ok).toBe(true);
    expect((await rpc("connect", {}, CP)).ok).toBe(true);
    await csms.waitForCall("BootNotification");
    await csms.waitForCall("StatusNotification");
    return { rpc, base };
  }

  const expectedReply = (id: string) => [
    4,
    id,
    "FormationViolation",
    "malformed",
    {},
  ];

  it("the control plane returns the CSMS's CALLERROR and refuses bad params", async () => {
    const { rpc } = await daemonWithConnectedCp();
    const ack = await rpc(
      "send_raw_frame",
      { frame: '[2,"raw-rpc","Heartbeat"]', waitMs: 3000 },
      CP,
    );
    expect(ack.ok).toBe(true);
    expect(ack.result).toEqual({
      sentFrame: '[2,"raw-rpc","Heartbeat"]',
      messageId: "raw-rpc",
      reply: expectedReply("raw-rpc"),
      closed: null,
    });

    // Non-JSON text crosses the control plane untouched (#393 review).
    const text = await rpc(
      "send_raw_frame",
      { frame: "not json at all", waitMs: 100 },
      CP,
    );
    expect(text.result).toEqual({
      sentFrame: "not json at all",
      messageId: null,
      reply: null,
      closed: null,
    });

    const refused = await rpc("send_raw_frame", { frame: 42 }, CP);
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("invalid_params");
  });

  it("the MCP tool returns the same outcome, and an error for an unknown charge point", async () => {
    const { base } = await daemonWithConnectedCp();
    const tool = async (args: unknown): Promise<any> => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "send_raw_frame", arguments: args },
        }),
      });
      const text = await response.text();
      return JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result;
    };

    const result = await tool({
      cpId: CP,
      frame: '[2,"raw-mcp"]',
      waitMs: 3000,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      messageId: "raw-mcp",
      reply: expectedReply("raw-mcp"),
    });

    const missing = await tool({ cpId: "CP-NOPE", frame: "[]" });
    expect(missing.isError).toBe(true);
  });

  it("the remote service and JSON-Lines mode reach it through the daemon", async () => {
    const { base } = await daemonWithConnectedCp();
    const remote = new RemoteChargePointService(base);
    cleanups.push(() => remote.dispose());

    const direct = await remote.sendRawFrame(CP, {
      frame: '[2,"raw-remote"]',
      waitMs: 3000,
    });
    expect(direct.reply).toEqual(expectedReply("raw-remote"));

    const viaJson = (await handleJsonCommand(
      { chargePointService: remote, cpId: CP },
      {
        command: "send_raw_frame",
        params: { frame: '[2,"raw-json"]', waitMs: 3000 },
      },
    )) as { reply: unknown };
    expect(viaJson.reply).toEqual(expectedReply("raw-json"));

    await expect(
      handleJsonCommand(
        { chargePointService: remote, cpId: CP },
        { command: "send_raw_frame", params: { waitMs: 10 } },
      ),
    ).rejects.toThrow(/frame/);
  });
});
