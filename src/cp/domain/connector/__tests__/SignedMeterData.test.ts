import { describe, it, expect } from "vitest";
import {
  OcmfMeter,
  SIGNED_METER_MODES,
  ocmfTime,
  toOcpp16SampledValue,
  toOcpp2SignedMeterValue,
  type SignedMeterMode,
} from "../SignedMeterData";
import { ConfigurationStore } from "../../charge-point/ConfigurationStore";
import { defaultConfiguration } from "../../charge-point/Configuration";
import type { ChargePoint } from "../../charge-point/ChargePoint";

/**
 * #315: the OCMF generator. Signatures are checked with WebCrypto, an
 * implementation independent of the `@noble/curves` signer, so a CSMS doing
 * the same check is what these tests stand in for.
 */

const meter = () =>
  new OcmfMeter({
    meterSerial: "CP-TEST-1",
    gatewayId: "ocpp-cp-simulator",
    gatewaySerial: "CP-TEST",
  });

const at = new Date(Date.UTC(2026, 9, 29, 8, 0, 0, 250));

/** Split `OCMF|payload|signature` and check the signature like a CSMS would. */
async function verify(ocmf: string, publicKeyDer: Uint8Array) {
  const [header, payload, signatureSection] = ocmf.split("|");
  expect(header).toBe("OCMF");
  const sig = JSON.parse(signatureSection) as { SD: string; SA: string };
  const der = hex(sig.SD);
  const raw = derToRaw(der);
  if (!raw) return false;
  const key = await crypto.subtle.importKey(
    "spki",
    new Uint8Array(publicKeyDer),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    raw,
    new TextEncoder().encode(payload),
  );
}

describe("OcmfMeter (#315)", () => {
  it("signs a record a CSMS can verify against the advertised key", async () => {
    const m = meter();
    const record = m.sign([{ reason: "B", energyWh: 1234500, at }], "04A2B3");
    expect(record.signingMethod).toBe("ECDSA-secp256r1-SHA256");
    expect(await verify(record.ocmf, record.publicKeyDer)).toBe(true);
    // The key is a P-256 SubjectPublicKeyInfo, as OCMF verifiers expect.
    expect(m.publicKeyHex).toMatch(/^3059301306072A8648CE3D0201/);
  });

  it("writes the payload OCMF verifiers need, with exact decimals", () => {
    const record = meter().sign(
      [{ reason: "E", energyWh: 1242300, at }],
      "04A2B3",
    );
    const payload = JSON.parse(record.ocmf.split("|")[1]) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      FV: "1.4",
      PG: "T1",
      MS: "CP-TEST-1",
      IS: true,
      IT: "ISO14443",
      ID: "04A2B3",
    });
    expect(payload.RD).toEqual([
      {
        TM: "2026-10-29T08:00:00,250+0000 S",
        TX: "E",
        RV: 1242.3,
        RI: "01-00:01.08.00*FF",
        RU: "kWh",
        EF: "",
        ST: "G",
      },
    ]);
    // The signed text keeps three decimals, which the parsed number hides.
    expect(record.ocmf).toContain('"RV":1242.300,');
  });

  it("counts every record on one transaction page counter", () => {
    const m = meter();
    const pages = [0, 1, 2].map(
      () =>
        JSON.parse(
          m
            .sign([{ reason: "C", energyWh: 1, at }], "", "invalid_signature")
            .ocmf.split("|")[1],
        ).PG,
    );
    expect(pages).toEqual(["T1", "T2", "T3"]);
  });

  it("marks a record with no idTag as unassigned", () => {
    const payload = JSON.parse(
      meter()
        .sign([{ reason: "C", energyWh: 1, at }], "")
        .ocmf.split("|")[1],
    );
    expect(payload).toMatchObject({ IS: false, IL: "NONE", IT: "NONE" });
    expect(payload.ID).toBeUndefined();
  });

  it.each([["tampered_payload"], ["wrong_key"], ["invalid_signature"]] as [
    SignedMeterMode,
  ][])("%s produces a record a CSMS must reject", async (mode) => {
    const m = meter();
    const record = m.sign([{ reason: "E", energyWh: 1234567, at }], "T", mode);
    expect(record.mode).toBe(mode);
    expect(record.publicKeyDer).toEqual(m.publicKeyDer);
    expect(await verify(record.ocmf, record.publicKeyDer)).toBe(false);
  });

  it("tampered_payload changes only the reading, after signing", () => {
    const m = meter();
    const record = m.sign(
      [{ reason: "E", energyWh: 1234567, at }],
      "T",
      "tampered_payload",
    );
    expect(record.ocmf).toContain('"RV":1234.568,');
  });

  it("lists every mode", () => {
    expect(SIGNED_METER_MODES).toEqual([
      "valid",
      "tampered_payload",
      "wrong_key",
      "invalid_signature",
    ]);
  });
});

describe("OCMF carriers (#315)", () => {
  it("maps one record onto OCPP 1.6 SignedData", () => {
    const record = meter().sign([{ reason: "B", energyWh: 0, at }], "T");
    expect(toOcpp16SampledValue(record.ocmf, "Transaction.Begin")).toEqual({
      value: record.ocmf,
      context: "Transaction.Begin",
      format: "SignedData",
      measurand: "Energy.Active.Import.Register",
      unit: "kWh",
    });
  });

  it("maps the same record onto OCPP 2.x signedMeterValue without loss", async () => {
    const record = meter().sign([{ reason: "B", energyWh: 0, at }], "T");
    const smv = toOcpp2SignedMeterValue(record);
    expect(smv.encodingMethod).toBe("OCMF");
    expect(smv.signingMethod).toBe("ECDSA-secp256r1-SHA256");
    const ocmf = new TextDecoder().decode(base64(smv.signedMeterData));
    expect(ocmf).toBe(record.ocmf);
    expect(await verify(ocmf, base64(smv.publicKey))).toBe(true);
  });

  it("formats OCMF time in UTC with millisecond precision", () => {
    expect(ocmfTime(at)).toBe("2026-10-29T08:00:00,250+0000 S");
  });
});

describe("signed meter configuration keys (#315)", () => {
  const store = () =>
    new ConfigurationStore(
      "CP-TEST",
      defaultConfiguration({
        connectorNumber: 1,
        wsUrl: "ws://localhost",
        supportsWebSocketPing: false,
      } as unknown as ChargePoint),
    );

  it("is off by default, in valid mode", () => {
    const s = store();
    expect(s.signReadings()).toBe(false);
    expect(s.signedMeterDataMode()).toBe("valid");
  });

  it("accepts the listed modes and rejects anything else", () => {
    const s = store();
    expect(s.applyChange("SignedMeterDataMode", "wrong_key")).toBe("Accepted");
    expect(s.signedMeterDataMode()).toBe("wrong_key");
    expect(s.applyChange("SignedMeterDataMode", "garbage")).toBe("Rejected");
    expect(s.signedMeterDataMode()).toBe("wrong_key");
    expect(s.applyChange("SampledDataSignReadings", "true")).toBe("Accepted");
    expect(s.signReadings()).toBe(true);
  });

  it("publishes a runtime key read-only", () => {
    const s = store();
    s.defineRuntimeKey("MeterPublicKey1", "3059");
    expect(s.get("MeterPublicKey1")?.value).toBe("3059");
    expect(s.applyChange("MeterPublicKey1", "00")).toBe("Rejected");
  });
});

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function base64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** DER ECDSA-Sig-Value → r||s (32 bytes each), or null if not DER. */
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  let i = 2;
  const out = new Uint8Array(64);
  for (const offset of [0, 32]) {
    if (der[i++] !== 0x02) return null;
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    out.set(v, offset + 32 - v.length);
  }
  return i === der.length ? out : null;
}
