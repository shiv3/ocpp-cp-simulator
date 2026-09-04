import { afterEach, describe, expect, it } from "bun:test";

import { Logger } from "../../../shared/Logger";
import { OCPPWebSocket } from "../OCPPWebSocket";
import {
  buildOcppWebSocketConnectOptions,
  probeUpgradeRefusal,
} from "../wsUrlWithBasic";

/**
 * #288 — a refused upgrade must say which refusal it was.
 *
 * Bun's native WebSocket reports 401, 404 and 301 identically
 * (`code=1002, Expected 101 status code`), and the daemon runs under Bun, so
 * the status is fetched after the fact. These tests pin the three operator
 * outcomes and, just as importantly, the gating: the diagnostic must not
 * multiply the CSMS's request rate while the reconnect loop runs.
 */

interface RefusingServer {
  readonly port: number;
  readonly requests: () => number;
  stop(): void;
}

function startRefusingServer(
  status: number,
  headers: Record<string, string> = {},
): RefusingServer {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests += 1;
      return new Response("", { status, headers });
    },
  });
  return {
    port: server.port,
    requests: () => requests,
    stop: () => server.stop(true),
  };
}

const servers: RefusingServer[] = [];
const sockets: OCPPWebSocket[] = [];

function tracked(status: number, headers?: Record<string, string>) {
  const server = startRefusingServer(status, headers);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.dispose();
  for (const server of servers.splice(0)) server.stop();
});

/** A logger whose WebSocket lines land in `lines` instead of only the console. */
function capturingLogger(lines: string[]): Logger {
  const logger = new Logger();
  logger.on("log", (entry: { message: string }) => {
    lines.push(entry.message);
  });
  return logger;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

describe("probeUpgradeRefusal", () => {
  it("reports the status for a refused upgrade", async () => {
    const server = tracked(401);
    const options = buildOcppWebSocketConnectOptions({
      baseUrl: `ws://127.0.0.1:${server.port}/ocpp/`,
      chargePointId: "CP001",
      basicAuth: { username: "CP001", password: "secret" },
      ocppVersion: "OCPP-1.6J",
    });

    expect(await probeUpgradeRefusal(options)).toEqual({ status: 401 });
  });

  it("reports a redirect's target, and never follows it", async () => {
    const target = "wss://edge.example/ocpp/CP001";
    const server = tracked(301, { Location: target });
    const options = buildOcppWebSocketConnectOptions({
      baseUrl: `ws://127.0.0.1:${server.port}/ocpp/`,
      chargePointId: "CP001",
      basicAuth: null,
      ocppVersion: "OCPP-1.6J",
    });

    // Following it would send the station's credentials to whatever host the
    // Location names, so the 3xx itself is the answer.
    expect(await probeUpgradeRefusal(options)).toEqual({
      status: 301,
      location: target,
    });
  });

  it("replays the handshake's own headers, so the CSMS answers the same question", async () => {
    let seen: Record<string, string> = {};
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        req.headers.forEach((value, key) => {
          seen[key] = value;
        });
        return new Response("", { status: 401 });
      },
    });
    try {
      const options = buildOcppWebSocketConnectOptions({
        baseUrl: `ws://127.0.0.1:${server.port}/ocpp/`,
        chargePointId: "CP001",
        basicAuth: { username: "CP001", password: "secret" },
        ocppVersion: "OCPP-1.6J",
        extraHeaders: { "X-Route": "lane-a" },
      });
      await probeUpgradeRefusal(options);

      expect(seen.upgrade).toBe("websocket");
      expect(seen["sec-websocket-protocol"]).toBe("ocpp1.6");
      expect(seen["x-route"]).toBe("lane-a");
      // The credential is what makes a 401 answer mean "these were refused".
      expect(seen.authorization).toBe(
        `Basic ${Buffer.from("CP001:secret").toString("base64")}`,
      );
    } finally {
      server.stop(true);
      seen = {};
    }
  });

  it("gives up on a server that accepts the request and never answers", async () => {
    // Otherwise the fetch stays pending forever while the reconnect loop
    // starts another one every minute.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(60_000);
        return new Response("late", { status: 401 });
      },
    });
    try {
      const started = Date.now();
      const result = await probeUpgradeRefusal({
        url: `ws://127.0.0.1:${server.port}/ocpp/CP001`,
        protocols: [],
        headers: {},
        useNodeWsFallback: false,
      });

      expect(result).toBeNull();
      // The cap is 10s; this asserts it is bounded, not its exact value.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      server.stop(true);
    }
  }, 25_000);

  it("returns null rather than throwing when it cannot conclude", async () => {
    expect(
      await probeUpgradeRefusal({
        // Port 1 refuses the TCP connection outright.
        url: "ws://127.0.0.1:1/ocpp/CP001",
        protocols: [],
        headers: {},
        useNodeWsFallback: false,
      }),
    ).toBeNull();
  });
});

describe("OCPPWebSocket handshake refusal (#288)", () => {
  function connectTo(port: number, lines: string[]): { socket: OCPPWebSocket } {
    const socket = new OCPPWebSocket(
      `ws://127.0.0.1:${port}/ocpp/`,
      "CP001",
      capturingLogger(lines),
      null,
    );
    sockets.push(socket);
    socket.connect();
    return { socket };
  }

  it("names a 401 and the operator's next move", async () => {
    const server = tracked(401);
    const lines: string[] = [];
    connectTo(server.port, lines);

    await waitFor(() => lines.some((l) => l.includes("upgrade refused")));
    const refusal = lines.find((l) => l.includes("upgrade refused"));
    expect(refusal).toContain("HTTP 401");
    expect(refusal).toContain("credentials refused");
  });

  it("names a 404 as an unknown charge point id", async () => {
    const server = tracked(404);
    const lines: string[] = [];
    connectTo(server.port, lines);

    await waitFor(() => lines.some((l) => l.includes("upgrade refused")));
    expect(lines.find((l) => l.includes("upgrade refused"))).toContain(
      "does not know this charge point id",
    );
  });

  it("names a redirect and its target", async () => {
    const server = tracked(301, { Location: "wss://edge.example/ocpp/" });
    const lines: string[] = [];
    connectTo(server.port, lines);

    await waitFor(() => lines.some((l) => l.includes("upgrade refused")));
    const refusal = lines.find((l) => l.includes("upgrade refused"));
    expect(refusal).toContain("HTTP 301");
    expect(refusal).toContain("wss://edge.example/ocpp/");
  });

  it("redacts a credential the CSMS puts in its redirect target", async () => {
    // The Location header is the CSMS's text, not ours, and it can carry
    // userinfo or a secret query of its own.
    const server = tracked(301, {
      Location: "wss://CP001:s3cr3t@edge.example/ocpp/?ocpp_ws_secret=hunter2",
    });
    const lines: string[] = [];
    connectTo(server.port, lines);

    await waitFor(() => lines.some((l) => l.includes("upgrade refused")));
    const refusal = lines.find((l) => l.includes("upgrade refused")) ?? "";
    expect(refusal).not.toContain("s3cr3t");
    expect(refusal).not.toContain("hunter2");
    expect(refusal).toContain("edge.example");
  });

  it("logs the client's own error message instead of the constant 'error'", async () => {
    const server = tracked(401);
    const lines: string[] = [];
    connectTo(server.port, lines);

    await waitFor(() => lines.some((l) => l.includes("WebSocket error:")));
    // The old line was `WebSocket error type: error`, which is the same string
    // for every failure there is.
    expect(lines.some((l) => l.includes("WebSocket error type:"))).toBe(false);
    expect(lines.some((l) => l.includes("Expected 101 status code"))).toBe(
      true,
    );
  });

  it("stays quiet when the failure is not a refused upgrade", async () => {
    // Nothing listens on this port, so the socket never gets an HTTP reply to
    // ask about: close code 1006, not 1002. Probing here would put a request
    // on the network for a server that is not there.
    const lines: string[] = [];
    const socket = new OCPPWebSocket(
      "ws://127.0.0.1:1/ocpp/",
      "CP001",
      capturingLogger(lines),
      null,
    );
    sockets.push(socket);
    socket.connect();

    await waitFor(() => lines.some((l) => l.includes("WebSocket closed:")));
    await Bun.sleep(300);
    expect(lines.some((l) => l.includes("upgrade refused"))).toBe(false);
  });

  it("probes once while the reconnect loop keeps failing", async () => {
    const server = tracked(401);
    const lines: string[] = [];
    connectTo(server.port, lines);

    // Wait for the reconnect loop to have made several attempts of its own.
    await waitFor(() => server.requests() >= 4, 8000);

    const refusals = lines.filter((l) => l.includes("upgrade refused"));
    expect(refusals).toHaveLength(1);
  });
});
