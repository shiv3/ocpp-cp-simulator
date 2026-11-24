import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import * as x509 from "@peculiar/x509";
import { WebSocketServer } from "ws";

import { probeConnection } from "../ws/connectionProbe";

/**
 * #1132 — the one-shot connection check, against local servers. Under vitest
 * the transport is the Node `ws` client, which reports the status of a
 * refused upgrade itself; the Bun path is pinned in connectionProbe.bun.test.
 */

x509.cryptoProvider.set(globalThis.crypto);

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function track(server: { close(cb: () => void): void }): void {
  closers.push(() => new Promise<void>((resolve) => server.close(resolve)));
}

async function listen(server: Server | ReturnType<typeof createTcpServer>) {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  track(server);
  return (server.address() as AddressInfo).port;
}

/** A CSMS that accepts `ocpp1.6` (or, with `protocol: false`, none). */
async function startCsms(opts: { protocol?: false } = {}) {
  const seen = { paths: [] as string[], messages: 0, closes: 0 };
  const http = createHttpServer();
  const wss = new WebSocketServer({
    server: http,
    handleProtocols: (protocols) =>
      opts.protocol === false
        ? false
        : (protocols.values().next().value ?? false),
  });
  wss.on("connection", (socket, req) => {
    seen.paths.push(req.url ?? "");
    socket.on("message", () => (seen.messages += 1));
    socket.on("close", () => (seen.closes += 1));
  });
  closers.push(
    () => new Promise<void>((resolve) => wss.close(() => resolve())),
  );
  return { port: await listen(http), seen };
}

/** Answers every upgrade with `status` and no body. */
async function startRefusing(status: number, reason = "Refused") {
  const http = createHttpServer();
  http.on("upgrade", (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\n\r\n`);
  });
  return listen(http);
}

const probe = (port: number, extra: Record<string, unknown> = {}) =>
  probeConnection({
    baseUrl: `ws://127.0.0.1:${port}/ocpp`,
    chargePointId: "CP001",
    ocppVersion: "OCPP-1.6J",
    basicAuth: null,
    timeoutMs: 3000,
    ...extra,
  });

describe("probeConnection (#1132)", () => {
  it("opens and closes a handshake exactly as the station would, sending nothing", async () => {
    const csms = await startCsms();
    const result = await probe(csms.port);

    expect(result).toMatchObject({
      ok: true,
      code: "ok",
      stage: "open",
      subprotocol: "ocpp1.6",
      url: `ws://127.0.0.1:${csms.port}/ocpp/CP001`,
      offeredSubprotocols: ["ocpp1.6"],
    });
    expect(csms.seen.paths).toEqual(["/ocpp/CP001"]);
    await waitFor(() => csms.seen.closes === 1);
    expect(csms.seen.messages).toBe(0);
  });

  it.each([
    [401, "credentials_refused"],
    [403, "credentials_refused"],
    [404, "path_not_found"],
    [429, "csms_busy"],
    [503, "csms_busy"],
    [500, "upgrade_refused"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const result = await probe(await startRefusing(status));
    expect(result).toMatchObject({
      ok: false,
      code,
      stage: "upgrade",
      httpStatus: status,
    });
    expect(result.message).toContain(`HTTP ${status}`);
  });

  it("reports a plain HTTP server as not_websocket", async () => {
    const http = createHttpServer((_req, res) => res.end("hello"));
    const result = await probe(await listen(http));
    expect(result).toMatchObject({
      ok: false,
      code: "not_websocket",
      stage: "upgrade",
      httpStatus: 200,
    });
  });

  it("reports a CSMS that agrees to no subprotocol", async () => {
    const csms = await startCsms({ protocol: false });
    const result = await probe(csms.port);
    expect(result).toMatchObject({
      ok: false,
      code: "subprotocol_not_agreed",
      stage: "subprotocol",
    });
  });

  it("reports a closed port as connection_refused", async () => {
    const tcp = createTcpServer();
    const port = await listen(tcp);
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    closers.pop();
    const result = await probe(port);
    expect(result).toMatchObject({
      ok: false,
      code: "connection_refused",
      stage: "tcp",
    });
  });

  it("times out on a server that accepts and never answers", async () => {
    const tcp = createTcpServer((socket) => {
      closers.push(async () => void socket.destroy());
    });
    const result = await probe(await listen(tcp), { timeoutMs: 300 });
    expect(result).toMatchObject({
      ok: false,
      code: "timeout",
      stage: "handshake",
    });
  });

  it("reports an untrusted CSMS certificate", async () => {
    const { cert, key } = await selfSigned();
    const https = createHttpsServer({ cert, key });
    https.on("upgrade", (_req, socket) => socket.destroy());
    const port = await listen(https as unknown as Server);
    const result = await probeConnection({
      baseUrl: `wss://127.0.0.1:${port}/ocpp`,
      chargePointId: "CP001",
      basicAuth: null,
      timeoutMs: 3000,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "tls_untrusted_certificate",
      stage: "tls",
    });
  });

  it("refuses an unusable URL or security profile without dialling", async () => {
    await expect(
      probeConnection({
        baseUrl: "http://csms.example/ocpp",
        chargePointId: "CP001",
        basicAuth: null,
      }),
    ).resolves.toMatchObject({ code: "invalid_url", stage: "config" });
    await expect(
      probeConnection({
        baseUrl: "ws://csms.example/ocpp",
        chargePointId: "CP001",
        basicAuth: null,
        securityProfile: 1,
      }),
    ).resolves.toMatchObject({
      code: "invalid_security_profile",
      stage: "config",
    });
  });

  it("redacts the password of the dialled URL and warns about a doubled id", async () => {
    const port = await startRefusing(401);
    const result = await probeConnection({
      baseUrl: `ws://CP001:s3cret@127.0.0.1:${port}/ocpp/CP001`,
      chargePointId: "CP001",
      basicAuth: null,
      timeoutMs: 3000,
    });
    expect(result.code).toBe("credentials_refused");
    expect(JSON.stringify(result)).not.toContain("s3cret");
    expect(result.url).toBe(
      `ws://CP001:[redacted]@127.0.0.1:${port}/ocpp/CP001/CP001`,
    );
    expect(result.warnings.join("\n")).toContain("already ends with");
  });
});

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function selfSigned(): Promise<{ cert: string; key: string }> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=127.0.0.1",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64");
  return {
    cert: cert.toString("pem"),
    key: `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`,
  };
}
