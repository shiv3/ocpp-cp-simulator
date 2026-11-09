import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import { Buffer } from "node:buffer";
import type { AddressInfo } from "node:net";
import * as x509 from "@peculiar/x509";
import { WebSocketServer } from "ws";

import { OCPPWebSocket } from "../OCPPWebSocket";
import { peerChainRootPem } from "../wsUrlWithBasic";
import { isCertificateInBundle } from "../../../domain/security/certificateHash";
import type { Logger } from "../../../shared/Logger";

/**
 * #563 (1.6 whitepaper M04.FR.06): with several `--tls-ca` roots, only the
 * root that ended the CSMS chain validates the connection. The Node `ws`
 * client can read it from the TLS socket; Bun's native client cannot, so
 * this row only runs where `ws` is the transport.
 */

x509.cryptoProvider.set(globalThis.crypto);

const RSA_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

const pem = (label: string, data: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${(
    Buffer.from(data)
      .toString("base64")
      .match(/.{1,64}/g) ?? []
  ).join("\n")}\n-----END ${label}-----\n`;

const keys = () => crypto.subtle.generateKey(RSA_ALG, true, ["sign", "verify"]);

async function root(cn: string, serial: string) {
  const pair = await keys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial,
    name: `CN=${cn}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: RSA_ALG,
    keys: pair,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(pair.publicKey),
    ],
  });
  return { cert, pair, pem: cert.toString("pem") };
}

async function serverLeaf(issuer: Awaited<ReturnType<typeof root>>) {
  const pair = await keys();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: "0a",
    subject: "CN=localhost",
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    publicKey: pair.publicKey,
    signingKey: issuer.pair.privateKey,
    signingAlgorithm: RSA_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.ExtendedKeyUsageExtension(
        [x509.ExtendedKeyUsage.serverAuth],
        true,
      ),
      new x509.SubjectAlternativeNameExtension(
        [{ type: "dns", value: "localhost" }],
        false,
      ),
    ],
  });
  return {
    cert: cert.toString("pem"),
    key: pem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
  };
}

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as Logger;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

async function connectTo(
  caBundle: (a: string, b: string) => string,
  signedBy: "A" | "B",
) {
  const rootA = await root("Trust Root A", "01");
  const rootB = await root("Trust Root B", "02");
  const leaf = await serverLeaf(signedBy === "A" ? rootA : rootB);
  const https: Server = createServer({ cert: leaf.cert, key: leaf.key });
  const wss = new WebSocketServer({
    server: https,
    handleProtocols: (p) => [...p][0] ?? false,
  });
  await new Promise<void>((resolve) => https.listen(0, "127.0.0.1", resolve));
  const port = (https.address() as AddressInfo).port;
  const ws = new OCPPWebSocket(
    `wss://localhost:${port}/ocpp`,
    "CP-TRUST",
    logger,
    null,
    {},
    [],
    "OCPP-1.6J",
    2,
    "0123456789abcdef",
    undefined,
    { ca: caBundle(rootA.pem, rootB.pem) },
  );
  cleanup.push(() => {
    ws.dispose();
    wss.close();
    https.close();
  });
  await new Promise<void>((resolve) => ws.connect(resolve));
  return { ws, rootA, rootB };
}

describe.skipIf("Bun" in globalThis)(
  "OCPPWebSocket.connectionTrustAnchorsPem (#563)",
  () => {
    it("narrows a two-root bundle to the root that ended the chain", async () => {
      const { ws, rootA, rootB } = await connectTo((a, b) => `${b}\n${a}`, "A");
      const anchors = ws.connectionTrustAnchorsPem() ?? "";
      expect(isCertificateInBundle(rootA.pem, anchors)).toBe(true);
      expect(isCertificateInBundle(rootB.pem, anchors)).toBe(false);
    });

    it("follows the root of the chain, not the position in the bundle", async () => {
      const { ws, rootA, rootB } = await connectTo((a, b) => `${a}\n${b}`, "B");
      const anchors = ws.connectionTrustAnchorsPem() ?? "";
      expect(isCertificateInBundle(rootB.pem, anchors)).toBe(true);
      expect(isCertificateInBundle(rootA.pem, anchors)).toBe(false);
    });
  },
);

type PeerCert = NonNullable<Parameters<typeof peerChainRootPem>[0]>;
type MutablePeerCert = { -readonly [K in keyof PeerCert]: PeerCert[K] };

describe("peerChainRootPem (#563)", () => {
  it("returns the certificate that is its own issuer", () => {
    const rootCert: MutablePeerCert = { raw: new Uint8Array([1, 2, 3, 4]) };
    rootCert.issuerCertificate = rootCert;
    const leaf: PeerCert = {
      raw: new Uint8Array([9]),
      issuerCertificate: rootCert,
    };
    expect(peerChainRootPem(leaf)).toBe(
      "-----BEGIN CERTIFICATE-----\nAQIDBA==\n-----END CERTIFICATE-----\n",
    );
  });

  it("answers undefined when the chain does not end in a self-signed certificate", () => {
    expect(peerChainRootPem(undefined)).toBeUndefined();
    expect(peerChainRootPem({ raw: new Uint8Array([1]) })).toBeUndefined();
    const a: MutablePeerCert = { raw: new Uint8Array([1]) };
    const b: PeerCert = { raw: new Uint8Array([2]), issuerCertificate: a };
    a.issuerCertificate = b;
    expect(peerChainRootPem(a)).toBeUndefined();
  });
});
