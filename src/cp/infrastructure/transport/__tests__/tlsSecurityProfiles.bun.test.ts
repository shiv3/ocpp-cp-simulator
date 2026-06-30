import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as x509 from "@peculiar/x509";

import type { Logger } from "../../../shared/Logger";
import { OCPPWebSocket } from "../OCPPWebSocket";
import { openOcppWebSocket } from "../wsUrlWithBasic";

x509.cryptoProvider.set(globalThis.crypto);

const RSA_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

const activeServers: Array<{ stop: () => Promise<void> }> = [];
let nextPort = 20_000 + Math.floor(Math.random() * 20_000);

function pem(label: string, data: ArrayBuffer): string {
  const base64 = Buffer.from(data).toString("base64");
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

async function generateKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(RSA_ALG, true, ["sign", "verify"]);
}

async function privateKeyPem(keys: CryptoKeyPair): Promise<string> {
  return pem(
    "PRIVATE KEY",
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
}

async function createCertificateFixture(): Promise<{
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  untrustedServerCert: string;
  untrustedServerKey: string;
}> {
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 86_400_000);
  const caKeys = await generateKeys();
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=OCPP Test CA",
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALG,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  async function signedLeaf(
    serialNumber: string,
    subject: string,
    usage: x509.ExtendedKeyUsage,
    san?: x509.JsonGeneralNames,
    issuerCert = caCert,
    issuerKeys = caKeys,
  ): Promise<{ cert: string; key: string }> {
    const keys = await generateKeys();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber,
      subject,
      issuer: issuerCert.subject,
      notBefore,
      notAfter,
      publicKey: keys.publicKey,
      signingKey: issuerKeys.privateKey,
      signingAlgorithm: RSA_ALG,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.ExtendedKeyUsageExtension([usage], true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature |
            x509.KeyUsageFlags.keyEncipherment,
          true,
        ),
        ...(san ? [new x509.SubjectAlternativeNameExtension(san, false)] : []),
      ],
    });
    return { cert: cert.toString("pem"), key: await privateKeyPem(keys) };
  }

  const server = await signedLeaf(
    "02",
    "CN=localhost",
    x509.ExtendedKeyUsage.serverAuth,
    [{ type: "dns", value: "localhost" }],
  );
  const client = await signedLeaf(
    "03",
    "CN=CP-P3,O=Example CPO",
    x509.ExtendedKeyUsage.clientAuth,
  );

  const untrustedCaKeys = await generateKeys();
  const untrustedCaCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "10",
    name: "CN=Untrusted OCPP Test CA",
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALG,
    keys: untrustedCaKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  const untrustedServer = await signedLeaf(
    "11",
    "CN=localhost",
    x509.ExtendedKeyUsage.serverAuth,
    [{ type: "dns", value: "localhost" }],
    untrustedCaCert,
    untrustedCaKeys,
  );

  return {
    caCert: caCert.toString("pem"),
    serverCert: server.cert,
    serverKey: server.key,
    clientCert: client.cert,
    clientKey: client.key,
    untrustedServerCert: untrustedServer.cert,
    untrustedServerKey: untrustedServer.key,
  };
}

function startTlsWebSocketServer(params: {
  cert: string;
  key: string;
  clientCa?: string;
  port: number;
}): {
  url: string;
  getAuthorization: () => string | null;
  waitForConnection: () => Promise<void>;
  stop: () => Promise<void>;
} {
  let authorization: string | null = null;
  const connectionWaiters = new Set<() => void>();
  let connected = false;

  const server = Bun.serve({
    port: params.port,
    tls: {
      cert: params.cert,
      key: params.key,
      ...(params.clientCa
        ? { ca: params.clientCa, requestCert: true, rejectUnauthorized: true }
        : {}),
    },
    fetch(req, srv) {
      authorization = req.headers.get("authorization");
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      open() {
        connected = true;
        for (const resolve of [...connectionWaiters]) {
          connectionWaiters.delete(resolve);
          resolve();
        }
      },
      message() {},
    },
  });
  const handle = {
    url: `wss://localhost:${params.port}/ocpp/`,
    getAuthorization: () => authorization,
    waitForConnection: () => {
      if (connected) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        function done() {
          clearTimeout(timer);
          resolve();
        }
        const timer = setTimeout(() => {
          connectionWaiters.delete(done);
          reject(new Error("Timed out waiting for TLS WebSocket connection"));
        }, 2_000);
        connectionWaiters.add(done);
      });
    },
    stop: () => server.stop(true),
  };
  activeServers.push(handle);
  return handle;
}

function getAvailablePort(): number {
  return nextPort++;
}

function canBindBunServe(): boolean {
  try {
    const server = Bun.serve({
      port: getAvailablePort(),
      fetch() {
        return new Response("ok");
      },
    });
    void server.stop(true);
    return true;
  } catch {
    return false;
  }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for open")),
      2_000,
    );
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket errored before open"));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket closed before open"));
    };
  });
}

async function expectNoUncaughtException<T>(run: () => Promise<T>): Promise<T> {
  const uncaughtErrors: unknown[] = [];
  const onUncaughtException = (error: unknown) => {
    uncaughtErrors.push(error);
  };

  process.on("uncaughtException", onUncaughtException);
  try {
    const result = await run();
    await Bun.sleep(50);
    expect(uncaughtErrors).toHaveLength(0);
    return result;
  } finally {
    process.removeListener("uncaughtException", onUncaughtException);
  }
}

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.stop();
  }
});

describe.skipIf(!canBindBunServe())("OCPP 1.6 TLS security profiles", () => {
  it("connects profile 2 with CA trust and Basic Auth", async () => {
    const certs = await createCertificateFixture();
    const server = startTlsWebSocketServer({
      cert: certs.serverCert,
      key: certs.serverKey,
      port: getAvailablePort(),
    });

    const ws = openOcppWebSocket({
      baseUrl: server.url,
      chargePointId: "CP-P2",
      basicAuth: null,
      securityProfile: 2,
      authorizationKey: "001122AABB",
      tls: { ca: certs.caCert, serverName: "localhost" },
    });

    try {
      await waitForOpen(ws);
      await server.waitForConnection();
      expect(server.getAuthorization()).toBe(
        `Basic ${Buffer.from("CP-P2:001122AABB").toString("base64")}`,
      );
    } finally {
      ws.close();
    }
  });

  it("connects profile 3 with a client certificate and no Basic Auth", async () => {
    const certs = await createCertificateFixture();
    const server = startTlsWebSocketServer({
      cert: certs.serverCert,
      key: certs.serverKey,
      clientCa: certs.caCert,
      port: getAvailablePort(),
    });

    const ws = openOcppWebSocket({
      baseUrl: server.url,
      chargePointId: "CP-P3",
      basicAuth: { username: "CP-P3", password: "should-not-send" },
      securityProfile: 3,
      authorizationKey: "001122AABB",
      tls: {
        ca: certs.caCert,
        cert: certs.clientCert,
        key: certs.clientKey,
        serverName: "localhost",
      },
    });

    try {
      await waitForOpen(ws);
      await server.waitForConnection();
      expect(server.getAuthorization()).toBeNull();
    } finally {
      ws.close();
    }
  });

  it("rejects an untrusted server certificate by default", async () => {
    const certs = await createCertificateFixture();
    const server = startTlsWebSocketServer({
      cert: certs.untrustedServerCert,
      key: certs.untrustedServerKey,
      port: getAvailablePort(),
    });

    const errorMessages: string[] = [];
    const ws = new OCPPWebSocket(
      server.url,
      "CP-REJECT",
      {
        info() {},
        warn() {},
        error(message: string) {
          errorMessages.push(message);
        },
      } as unknown as Logger,
      null,
      {},
      [],
      "OCPP-1.6J",
      2,
      "001122AABB",
      undefined,
      { ca: certs.caCert, serverName: "localhost" },
    );

    try {
      const closeEvent = await expectNoUncaughtException(
        () =>
          new Promise<CloseEvent>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("Timed out waiting for TLS rejection"));
            }, 2_000);
            ws.connect(null, (event) => {
              clearTimeout(timer);
              resolve(event);
            });
          }),
      );

      expect(closeEvent.wasClean).toBe(false);
      expect(errorMessages).toContain("WebSocket error type: error");
    } finally {
      ws.disconnect();
    }
  });
});
