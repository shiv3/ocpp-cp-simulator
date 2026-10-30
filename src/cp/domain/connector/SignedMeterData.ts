import { p256 } from "@noble/curves/nist.js";
import type { ReadingContext, SampledValue } from "./MeterValueBuilder";

/**
 * Signed meter data in the Open Charge Metering Format (OCMF 1.4, S.A.F.E.
 * e.V.), the format German calibration-law (Eichrecht) charge points use to
 * sign the energy they bill (#315).
 *
 * This simulates the WIRE FORMAT. It is not a calibrated meter, and nothing it
 * produces is legally valid metering data.
 *
 * The generator knows nothing about OCPP versions; {@link toOcpp16SampledValue}
 * and {@link toOcpp2SignedMeterValue} map one record onto each carrier.
 * Signing is synchronous (`@noble/curves`), so turning it on never reorders
 * the messages a station sends, which an async WebCrypto signature would.
 */

/** OCMF Table 22 identifier of the only algorithm this simulator signs with. */
export const OCMF_SIGNING_METHOD = "ECDSA-secp256r1-SHA256";

/**
 * What the next signed record looks like on the wire. Everything but `valid`
 * is deliberately wrong, so a CSMS's rejection path can be exercised (#315).
 */
export const SIGNED_METER_MODES = [
  "valid",
  "tampered_payload",
  "wrong_key",
  "invalid_signature",
] as const;
export type SignedMeterMode = (typeof SIGNED_METER_MODES)[number];

export function isSignedMeterMode(value: unknown): value is SignedMeterMode {
  return (SIGNED_METER_MODES as readonly unknown[]).includes(value);
}

/** OCMF `TX` reading reasons this simulator emits: Begin, Charging, End. */
export type OcmfTransactionReason = "B" | "C" | "E";

export interface OcmfReading {
  reason: OcmfTransactionReason;
  /** Energy register in Wh; written as kWh with three decimals. */
  energyWh: number;
  at: Date;
}

export interface SignedMeterRecord {
  /** The whole `OCMF|<payload>|<signature>` document. */
  ocmf: string;
  signingMethod: typeof OCMF_SIGNING_METHOD;
  /** The key a verifier should use: always this meter's, in every mode. */
  publicKeyDer: Uint8Array;
  mode: SignedMeterMode;
}

// SubjectPublicKeyInfo prefix for an uncompressed P-256 point
// (id-ecPublicKey, prime256v1, BIT STRING of 66 bytes).
const P256_SPKI_PREFIX = hexToBytes(
  "3059301306072a8648ce3d020106082a8648ce3d030107034200",
);

/**
 * One connector's simulated signing meter: an ephemeral P-256 key held in
 * memory (no store, import or rotation, per #315) and the OCMF transaction
 * pagination counter, which counts every record it signs.
 */
export class OcmfMeter {
  private readonly secretKey: Uint8Array;
  readonly publicKeyDer: Uint8Array;
  private page = 1;

  constructor(
    readonly identity: {
      meterSerial: string;
      gatewayId: string;
      gatewaySerial: string;
    },
  ) {
    this.secretKey = p256.utils.randomSecretKey();
    this.publicKeyDer = spkiFor(this.secretKey);
  }

  /** Hex DER SubjectPublicKeyInfo, the form OCMF verifiers take. */
  get publicKeyHex(): string {
    return bytesToHex(this.publicKeyDer);
  }

  /**
   * Sign one OCMF record holding `readings`, then apply `mode`. The record
   * consumes one page number whatever the mode, as a real meter's would.
   */
  sign(
    readings: OcmfReading[],
    idTag: string,
    mode: SignedMeterMode = "valid",
  ): SignedMeterRecord {
    const payload = this.payloadFor(readings, idTag, this.page++);
    const signingKey =
      mode === "wrong_key" ? p256.utils.randomSecretKey() : this.secretKey;
    let signature = bytesToHex(
      p256.sign(new TextEncoder().encode(payload), signingKey, {
        format: "der",
      }),
    );
    let signedPayload = payload;
    if (mode === "tampered_payload") signedPayload = bumpLastReading(payload);
    if (mode === "invalid_signature") signature = "DEADBEEF".repeat(9);
    const signatureSection = JSON.stringify({
      SA: OCMF_SIGNING_METHOD,
      SE: "hex",
      SM: "application/x-der",
      SD: signature,
    });
    return {
      ocmf: `OCMF|${signedPayload}|${signatureSection}`,
      signingMethod: OCMF_SIGNING_METHOD,
      publicKeyDer: this.publicKeyDer,
      mode,
    };
  }

  /**
   * The payload section, compact and in a fixed key order. OCMF signs this
   * exact text, so it is built by hand: `RV` keeps three decimals
   * (`1234.500`, not `1234.5`), which a JSON round trip would lose.
   */
  private payloadFor(
    readings: OcmfReading[],
    idTag: string,
    page: number,
  ): string {
    const head = {
      FV: "1.4",
      GI: this.identity.gatewayId,
      GS: this.identity.gatewaySerial,
      PG: `T${page}`,
      MV: "ocpp-cp-simulator",
      MM: "simulated-meter",
      MS: this.identity.meterSerial,
      IS: idTag !== "",
      IL: idTag !== "" ? "TRUSTED" : "NONE",
      // No identification detail is claimed: the record does not know whether
      // the tag came from an Authorize result, the cache or a timeout path.
      IF: [],
      IT: idTag !== "" ? "ISO14443" : "NONE",
      ...(idTag !== "" ? { ID: idTag } : {}),
    };
    const rd = readings.map(
      (r) =>
        `{"TM":${JSON.stringify(ocmfTime(r.at))},"TX":"${r.reason}","RV":${kwh(
          r.energyWh,
        )},"RI":"01-00:01.08.00*FF","RU":"kWh","EF":"","ST":"G"}`,
    );
    // OCMF sections are split on `|`, so one inside a value (an idTag, a
    // serial) is written as the JSON escape `\u007C`; it decodes the same.
    const headJson = JSON.stringify(head).replace(/\|/g, "\\u007C");
    return `${headJson.slice(0, -1)},"RD":[${rd.join(",")}]}`;
  }
}

/**
 * OCPP 1.6 carrier: a SampledValue with `format: "SignedData"` whose value is
 * the OCMF document. 1.6 has no field for the method or the key; those travel
 * in configuration keys (`MeterPublicKey<connectorId>`).
 */
export function toOcpp16SampledValue(
  ocmf: string,
  context: ReadingContext,
): SampledValue {
  return {
    value: ocmf,
    context,
    format: "SignedData",
    measurand: "Energy.Active.Import.Register",
    unit: "kWh",
  };
}

/** OCPP 2.0.1 / 2.1 `SignedMeterValueType`. */
export interface SignedMeterValue {
  signedMeterData: string;
  signingMethod: string;
  encodingMethod: string;
  publicKey: string;
}

/**
 * OCPP 2.x carrier. All four fields are filled: 2.0.1 requires them, and 2.1
 * (where `signingMethod` and `publicKey` became optional) accepts them, so one
 * output serves both versions without losing anything.
 */
export function toOcpp2SignedMeterValue(
  record: SignedMeterRecord,
): SignedMeterValue {
  return {
    signedMeterData: bytesToBase64(new TextEncoder().encode(record.ocmf)),
    signingMethod: record.signingMethod,
    encodingMethod: "OCMF",
    publicKey: bytesToBase64(record.publicKeyDer),
  };
}

/** `2026-10-29T08:00:00,000+0000 S`: OCMF time with a synchronized clock. */
export function ocmfTime(at: Date): string {
  return `${at.toISOString().slice(0, 19)},${at
    .toISOString()
    .slice(20, 23)}+0000 S`;
}

/** Wh as kWh with three decimals. A negative register is written as it is
 *  (`-1.500`), not clamped: the record must show what the meter was told. */
function kwh(energyWh: number): string {
  const wh = Math.round(energyWh);
  const abs = Math.abs(wh);
  return `${wh < 0 ? "-" : ""}${Math.floor(abs / 1000)}.${String(
    abs % 1000,
  ).padStart(3, "0")}`;
}

/** Change the last digit of the last `RV`, after signing. */
function bumpLastReading(payload: string): string {
  const at = payload.lastIndexOf('"RV":');
  if (at === -1) throw new Error("tampered_payload needs at least one reading");
  const end = payload.indexOf(",", at);
  const digit = Number(payload[end - 1]);
  return `${payload.slice(0, end - 1)}${(digit + 1) % 10}${payload.slice(end)}`;
}

function spkiFor(secretKey: Uint8Array): Uint8Array {
  const point = p256.getPublicKey(secretKey, false);
  const out = new Uint8Array(P256_SPKI_PREFIX.length + point.length);
  out.set(P256_SPKI_PREFIX);
  out.set(point, P256_SPKI_PREFIX.length);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** What {@link signReading} needs from a charge point (structural, so this
 *  module does not import ChargePoint). */
export interface SignedMeterSource {
  signedMeterFor(connectorId: number): OcmfMeter | null;
  readonly configuration: { signedMeterDataMode(): SignedMeterMode };
}

/**
 * Sign one reading for `connectorId` in the configured mode, or return `null`
 * when `SampledDataSignReadings` is off, so callers cost nothing then.
 */
export function signReading(
  cp: SignedMeterSource,
  connectorId: number,
  idTag: string,
  reading: OcmfReading,
): SignedMeterRecord | null {
  const meter = cp.signedMeterFor(connectorId);
  if (!meter) return null;
  // A register too large to write as plain decimal digits (1e+24 Wh) cannot be
  // an OCMF `RV`, so nothing is signed for it.
  if (!Number.isSafeInteger(Math.round(reading.energyWh))) return null;
  return meter.sign([reading], idTag, cp.configuration.signedMeterDataMode());
}
