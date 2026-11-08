import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as x509 from "@peculiar/x509";

import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { canBindBunServe } from "../../../../test/bunServe";
import { startMockCsms, type MockCsms } from "./mockCsms";

x509.cryptoProvider.set(globalThis.crypto as Crypto);

/**
 * #724: a ChangeConfiguration of AuthorizationKey reaches the transport
 * (A01.FR.03) and a SecurityProfile change is checked (A05.FR.01-04), answers
 * Accepted and reconnects with the new profile (A05.FR.05-07), falling back
 * to the previous one when that connection fails (A05.FR.08).
 */

const OLD_KEY = "11".repeat(16);
const NEW_KEY = "22".repeat(16);

/** The Basic header for a hex AuthorizationKey (whitepaper §7.2: the bytes). */
function basic(id: string, hexKey: string): string {
  const password = Buffer.from(hexKey, "hex").toString("latin1");
  return `Basic ${Buffer.from(`${id}:${password}`, "latin1").toString("base64")}`;
}

async function localhostCertificate(): Promise<{ cert: string; key: string }> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=localhost",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
      ]),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    ],
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  return {
    cert: cert.toString("pem"),
    key: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
  };
}

const stops: Array<() => Promise<void>> = [];
const disconnects: Array<() => void> = [];
afterEach(async () => {
  while (disconnects.length) disconnects.pop()?.();
  while (stops.length) await stops.pop()?.();
});

async function connectedStation(
  csms: MockCsms,
  id: string,
  securityProfile: 0 | 1 | 2 | 3,
  tls?: { ca: string; serverName: string },
): Promise<ChargePoint> {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
    securityProfile,
    OLD_KEY,
    undefined,
    tls,
  );
  cp.events.on("error", () => undefined);
  disconnects.push(() => cp.disconnect());
  cp.connect();
  await acceptBoot(csms);
  return cp;
}

async function acceptBoot(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "BootNotification" &&
      !answered.has(f[1] as string),
    10_000,
  );
  answered.add(boot[1] as string);
  csms.replyCallResult(boot[1] as string, {
    status: "Accepted",
    currentTime: "2026-06-30T00:00:00.000Z",
    interval: 300,
  });
}
const answered = new Set<string>();

async function changeConfiguration(
  csms: MockCsms,
  id: string,
  key: string,
  value: string,
): Promise<unknown> {
  csms.send([2, id, "ChangeConfiguration", { key, value }]);
  const result = await csms.waitForFrame((f) => f[0] === 3 && f[1] === id);
  return result[2];
}

describe.skipIf(!canBindBunServe())("1.6 security configuration (#724)", () => {
  it("keeps the old profile and answers Rejected when a prerequisite is missing (A05.FR.01-04)", async () => {
    const csms = startMockCsms();
    stops.push(() => csms.stop());
    const cp = await connectedStation(csms, "CP-724-GUARD", 1);

    // A05.FR.01: a downgrade, and an equal value above 1.
    expect(
      await changeConfiguration(csms, "c1", "SecurityProfile", "0"),
    ).toEqual({
      status: "Rejected",
    });
    // A05.FR.03: no CentralSystemRootCertificate installed.
    expect(
      await changeConfiguration(csms, "c2", "SecurityProfile", "2"),
    ).toEqual({
      status: "Rejected",
    });
    // A05.FR.04.
    expect(
      await changeConfiguration(csms, "c3", "SecurityProfile", "3"),
    ).toEqual({
      status: "Rejected",
    });
    expect(cp.configuration.getInteger("SecurityProfile")).toBe(1);
    expect(csms.openCount()).toBe(1);
  });

  it("presents the new AuthorizationKey on the next connection (A01.FR.03)", async () => {
    const csms = startMockCsms();
    stops.push(() => csms.stop());
    await connectedStation(csms, "CP-724-KEY", 1);
    expect(csms.upgradeAuthorizations).toEqual([basic("CP-724-KEY", OLD_KEY)]);

    expect(
      await changeConfiguration(csms, "k1", "AuthorizationKey", NEW_KEY),
    ).toEqual({ status: "Accepted" });
    // The CSMS now only accepts the new credentials: it drops the link.
    csms.closeCurrentConnection(1012);
    await csms.waitForConnection(10_000).catch(() => undefined);
    await acceptBoot(csms);

    expect(csms.upgradeAuthorizations).toEqual([
      basic("CP-724-KEY", OLD_KEY),
      basic("CP-724-KEY", NEW_KEY),
    ]);
  }, 20_000);

  it("falls back to the previous profile when the new connection fails (A05.FR.08)", async () => {
    const { cert } = await localhostCertificate();
    // A plain ws:// CSMS: profile 2 promotes the next attempt to wss://,
    // which it cannot serve.
    const csms = startMockCsms();
    stops.push(() => csms.stop());
    const cp = await connectedStation(csms, "CP-724-FALLBACK", 1, {
      ca: cert,
      serverName: "localhost",
    });

    expect(
      await changeConfiguration(csms, "p1", "SecurityProfile", "2"),
    ).toEqual({ status: "Accepted" });
    expect(cp.configuration.getInteger("SecurityProfile")).toBe(2);

    await acceptBootAgain(csms);
    expect(cp.configuration.getInteger("SecurityProfile")).toBe(1);
  }, 30_000);

  it("reconnects over wss:// with Basic Auth after an accepted 1 → 2 (A05.FR.05-07)", async () => {
    const { cert, key } = await localhostCertificate();
    const csms = startMockCsms({ tls: { cert, key } });
    stops.push(() => csms.stop());
    const url = csms.url;
    expect(url.startsWith("wss://")).toBe(true);
    const cp = await connectedStation(csms, "CP-724-WSS", 1, {
      ca: cert,
      serverName: "localhost",
    });

    expect(
      await changeConfiguration(csms, "w1", "SecurityProfile", "2"),
    ).toEqual({ status: "Accepted" });
    await csms.waitForConnection(10_000).catch(() => undefined);
    await acceptBootAgain(csms);

    expect(cp.configuration.getInteger("SecurityProfile")).toBe(2);
    expect(csms.upgradeAuthorizations).toHaveLength(2);
    expect(csms.upgradeAuthorizations[1]).toBe(basic("CP-724-WSS", OLD_KEY));
  }, 30_000);
});

/** Accepts the next BootNotification of a new connection. */
async function acceptBootAgain(csms: MockCsms): Promise<void> {
  await acceptBoot(csms);
}
