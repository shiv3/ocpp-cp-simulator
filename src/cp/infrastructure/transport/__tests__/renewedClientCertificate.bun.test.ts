import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import * as x509 from "@peculiar/x509";

import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { canBindBunServe, tcpPort } from "../../../../test/bunServe";

/**
 * #537 A02.FR.08: once CertificateSigned installs a new Charging Station
 * certificate, a security-profile-3 station reconnects and presents it as
 * its TLS client certificate. A02.FR.28: when the CSMS refuses it, the
 * station falls back to the configured one.
 *
 * Bun's server does not expose the peer certificate, so which one the
 * station presents is read from which client CA the CSMS trusts.
 */

x509.cryptoProvider.set(globalThis.crypto as Crypto);

type Version = "OCPP-2.0.1" | "OCPP-2.1";

const EC_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

function pem(label: string, der: ArrayBuffer): string {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

interface Authority {
  name: string;
  pem: string;
  keys: CryptoKeyPair;
}

async function authority(serial: string, cn: string): Promise<Authority> {
  const keys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const name = `CN=${cn}`;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial,
    name,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: EC_ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
    ],
  });
  return { name, pem: cert.toString("pem"), keys };
}

async function issue(
  ca: Authority,
  serial: string,
  subject: string,
  publicKey: CryptoKey | x509.PublicKey,
  options: { notBefore?: Date; server?: boolean } = {},
): Promise<string> {
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial,
    subject,
    issuer: ca.name,
    notBefore: options.notBefore ?? new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: EC_ALG,
    publicKey,
    signingKey: ca.keys.privateKey,
    extensions: options.server
      ? [
          new x509.SubjectAlternativeNameExtension([
            { type: "dns", value: "localhost" },
          ]),
        ]
      : [],
  });
  return cert.toString("pem");
}

interface Pki {
  /** Issues the server certificate and the configured client one. */
  operatorCa: Authority;
  /** Signs the renewed Charging Station certificate. */
  renewalCa: Authority;
  server: { cert: string; key: string };
  client: { cert: string; key: string };
}

async function pki(): Promise<Pki> {
  const operatorCa = await authority("01", "Operator CA");
  const renewalCa = await authority("02", "Renewal CA");
  const serverKeys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  const clientKeys = await crypto.subtle.generateKey(EC_ALG, true, [
    "sign",
    "verify",
  ]);
  return {
    operatorCa,
    renewalCa,
    server: {
      cert: await issue(
        operatorCa,
        "10",
        "CN=localhost",
        serverKeys.publicKey,
        {
          server: true,
        },
      ),
      key: pem(
        "PRIVATE KEY",
        await crypto.subtle.exportKey("pkcs8", serverKeys.privateKey),
      ),
    },
    client: {
      cert: await issue(operatorCa, "11", "CN=CP-RENEW", clientKeys.publicKey),
      key: pem(
        "PRIVATE KEY",
        await crypto.subtle.exportKey("pkcs8", clientKeys.privateKey),
      ),
    },
  };
}

const stations: ChargePoint[] = [];
const servers: MockCsms[] = [];

afterEach(async () => {
  for (const cp of stations.splice(0)) cp.disconnect();
  for (const csms of servers.splice(0)) await csms.stop();
});

function csmsOn(port: number, certs: Pki, clientCa: string[]): MockCsms {
  const csms = startMockCsms({
    port,
    tls: { cert: certs.server.cert, key: certs.server.key, clientCa },
  });
  servers.push(csms);
  return csms;
}

function station(version: Version, url: string, certs: Pki): ChargePoint {
  const cp = new ChargePoint(
    "CP-RENEW",
    DefaultBootNotification,
    1,
    url,
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
    {
      ca: certs.operatorCa.pem,
      cert: certs.client.cert,
      key: certs.client.key,
      serverName: "localhost",
    },
  );
  cp.events.on("error", () => undefined);
  stations.push(cp);
  return cp;
}

/** Answers the next BootNotification and waits for the boot to settle. */
async function bootOn(csms: MockCsms, after = 0): Promise<void> {
  const boot = await csms.waitForFrame(
    (frame) =>
      frame[0] === 2 &&
      frame[2] === "BootNotification" &&
      csms.received.indexOf(frame) >= after,
    8_000,
  );
  csms.replyCallResult(boot[1] as string, {
    status: "Accepted",
    currentTime: new Date().toISOString(),
    interval: 300,
  });
}

/** Has the CSMS send CertificateSigned with a chain signed for a CSR the
 *  station generated, and returns its answer. */
async function installRenewedCertificate(
  csms: MockCsms,
  cp: ChargePoint,
  certs: Pki,
  notBefore?: Date,
): Promise<unknown> {
  const csr = new x509.Pkcs10CertificateRequest(
    await cp.certificateStore.generateNewCsr(cp.id, "Example CPO"),
  );
  const leaf = await issue(certs.renewalCa, "20", csr.subject, csr.publicKey, {
    notBefore,
  });
  const id = "cs-1";
  csms.send([2, id, "CertificateSigned", { certificateChain: leaf }]);
  const answer = await csms.waitForFrame(
    (frame) => frame[0] === 3 && frame[1] === id,
  );
  return answer[2];
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = tcpPort(probe);
  void probe.stop(true);
  return port;
}

describe.skipIf(!canBindBunServe())(
  "Renewed Charging Station certificate as TLS client identity (#537)",
  () => {
    describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)("%s", (version) => {
      it("reconnects with the signed certificate (A02.FR.08)", async () => {
        const certs = await pki();
        const port = freePort();
        const both = [certs.operatorCa.pem, certs.renewalCa.pem];
        const first = csmsOn(port, certs, both);
        const cp = station(version, first.url, certs);
        cp.connect();
        await bootOn(first);

        expect(await installRenewedCertificate(first, cp, certs)).toEqual({
          status: "Accepted",
        });
        // The station closes and reconnects at once.
        await waitUntil(() => first.openCount() === 2, 5_000);
        await first.stop();

        // A CSMS that trusts only the renewal CA takes the next connection:
        // the station presents the renewed certificate.
        const renewalOnly = csmsOn(port, certs, [certs.renewalCa.pem]);
        await waitUntil(() => renewalOnly.openCount() === 1, 8_000);
      }, 20_000);
    });

    it("falls back to the configured certificate when the CSMS refuses the renewed one (A02.FR.28)", async () => {
      const certs = await pki();
      const port = freePort();
      const operatorOnly = csmsOn(port, certs, [certs.operatorCa.pem]);
      const cp = station("OCPP-2.1", operatorOnly.url, certs);
      const logs: string[] = [];
      cp.events.on("log", (entry) => logs.push(entry.message));
      cp.connect();
      await bootOn(operatorOnly);

      expect(await installRenewedCertificate(operatorOnly, cp, certs)).toEqual({
        status: "Accepted",
      });

      // The renewed certificate is refused at the handshake; the next
      // attempt presents the configured one and gets in.
      await waitUntil(() => operatorOnly.openCount() === 2, 8_000);
      expect(logs.some((line) => line.includes("(A02.FR.28)"))).toBe(true);
      expect(logs.some((line) => line.includes("(A02.FR.10)"))).toBe(true);
    }, 20_000);

    it("waits for the certificate's notBefore before switching (2.0.1 A02.FR.08)", async () => {
      const certs = await pki();
      const port = freePort();
      const both = [certs.operatorCa.pem, certs.renewalCa.pem];
      const csms = csmsOn(port, certs, both);
      const cp = station("OCPP-2.0.1", csms.url, certs);
      cp.connect();
      await bootOn(csms);

      expect(
        await installRenewedCertificate(
          csms,
          cp,
          certs,
          // Certificate times have a one-second resolution: notBefore lands
          // between 2 and 3 seconds from now.
          new Date(Date.now() + 3_000),
        ),
      ).toEqual({ status: "Accepted" });
      await Bun.sleep(1_000);
      expect(csms.openCount()).toBe(1);
      await waitUntil(() => csms.openCount() === 2, 6_000);
    }, 20_000);
  },
);
