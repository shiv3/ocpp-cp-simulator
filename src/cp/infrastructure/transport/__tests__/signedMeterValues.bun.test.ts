import { describe, it, expect } from "bun:test";
import type {
  MeterValuesRequestV16,
  StopTransactionRequestV16,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";

/**
 * #315: OCMF signed meter data on the wire. A 1.6 station sends `SignedData`
 * samples (MeterValues during the transaction, begin + end in
 * StopTransaction.transactionData); a 2.x station fills `signedMeterValue`
 * on TransactionEvent and MeterValues. Every signature is checked with
 * WebCrypto against the key the station advertises, as a CSMS would.
 */

interface Signed {
  ocmf: string;
  publicKeyDer: Uint8Array;
}

async function verifies({ ocmf, publicKeyDer }: Signed): Promise<boolean> {
  const [, payload, signatureSection] = ocmf.split("|");
  const der = hex((JSON.parse(signatureSection) as { SD: string }).SD);
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

const reading = (ocmf: string) =>
  JSON.parse(ocmf.split("|")[1]) as { PG: string; RD: { TX: string }[] };

/** Start, sample and stop one 1.6 transaction; returns the station.
 *  `beforeStop` runs after the MeterValues sample, before the stop. */
async function run16(
  csms: MockCsms,
  id: string,
  setup: (cp: ChargePoint) => void,
  beforeStop: (cp: ChargePoint) => void = () => {},
): Promise<ChargePoint> {
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  setup(cp);
  const stop = answerEverythingElse(csms, ["StartTransaction"]);
  try {
    cp.startTransaction("TAG-315", 1);
    const start = await csms.waitForCall("StartTransaction");
    csms.replyCallResult(start.messageId, {
      transactionId: 315,
      idTagInfo: { status: "Accepted" },
    });
    await csms.waitForFrame(
      (f) =>
        callOf("StatusNotification")(f) &&
        (f[3] as { status?: string }).status === "Charging",
    );
    cp.sendMeterValue(1);
    await csms.waitForCall("MeterValues");
    beforeStop(cp);
    cp.stopTransaction(1);
    await csms.waitForCall("StopTransaction");
  } finally {
    stop();
  }
  return cp;
}

describe("OCPP 1.6 signed meter values (#315)", () => {
  it("sends nothing signed and makes no key while signing is off", async () => {
    const csms = startMockCsms();
    try {
      const cp = await run16(csms, "CP315-OFF", () => {});
      const mv = callsOf(csms, "MeterValues")[0][3] as MeterValuesRequestV16;
      expect(
        mv.meterValue[0].sampledValue.some((s) => s.format === "SignedData"),
      ).toBe(false);
      const stopTx = callsOf(
        csms,
        "StopTransaction",
      )[0][3] as StopTransactionRequestV16;
      expect(stopTx.transactionData).toBeUndefined();
      expect(cp.configuration.get("MeterPublicKey1")).toBeUndefined();
      cp.disconnect();
    } finally {
      await csms.stop();
    }
  });

  it("signs MeterValues and StopTransaction begin/end against MeterPublicKey1", async () => {
    const csms = startMockCsms();
    try {
      const cp = await run16(csms, "CP315-ON", (station) =>
        station.configuration.applyChange("SampledDataSignReadings", "true"),
      );
      const keyHex = cp.configuration.get("MeterPublicKey1")?.value as string;
      expect(keyHex).toMatch(/^3059301306072A8648CE3D0201/);
      const publicKeyDer = hex(keyHex);

      const mv = callsOf(csms, "MeterValues")[0][3] as MeterValuesRequestV16;
      const signedSample = mv.meterValue[0].sampledValue.find(
        (s) => s.format === "SignedData",
      );
      expect(signedSample).toMatchObject({
        measurand: "Energy.Active.Import.Register",
      });
      expect(await verifies({ ocmf: signedSample!.value, publicKeyDer })).toBe(
        true,
      );

      const stopTx = callsOf(
        csms,
        "StopTransaction",
      )[0][3] as StopTransactionRequestV16;
      const data = stopTx.transactionData!;
      expect(data.map((d) => d.sampledValue[0].context)).toEqual([
        "Transaction.Begin",
        "Transaction.End",
      ]);
      for (const d of data) {
        expect(d.sampledValue[0].format).toBe("SignedData");
        expect(
          await verifies({ ocmf: d.sampledValue[0].value, publicKeyDer }),
        ).toBe(true);
      }
      // Begin was signed first: pages run in time order B, C, E.
      const begin = reading(data[0].sampledValue[0].value);
      const middle = reading(signedSample!.value);
      const end = reading(data[1].sampledValue[0].value);
      expect([begin.PG, middle.PG, end.PG]).toEqual(["T1", "T2", "T3"]);
      expect([begin.RD[0].TX, middle.RD[0].TX, end.RD[0].TX]).toEqual([
        "B",
        "C",
        "E",
      ]);
      cp.disconnect();
    } finally {
      await csms.stop();
    }
  });

  it("keeps the signed begin reading when signing is turned off before the stop", async () => {
    const csms = startMockCsms();
    try {
      const cp = await run16(
        csms,
        "CP315-OFF-MID",
        (station) =>
          station.configuration.applyChange("SampledDataSignReadings", "true"),
        (station) =>
          station.configuration.applyChange("SampledDataSignReadings", "false"),
      );
      const publicKeyDer = hex(
        cp.configuration.get("MeterPublicKey1")?.value as string,
      );
      const stopTx = callsOf(
        csms,
        "StopTransaction",
      )[0][3] as StopTransactionRequestV16;
      const data = stopTx.transactionData!;
      expect(data.map((d) => d.sampledValue[0].context)).toEqual([
        "Transaction.Begin",
      ]);
      expect(
        await verifies({ ocmf: data[0].sampledValue[0].value, publicKeyDer }),
      ).toBe(true);
      cp.disconnect();
    } finally {
      await csms.stop();
    }
  });

  it("emits records a CSMS must reject in tampered_payload mode", async () => {
    const csms = startMockCsms();
    try {
      const cp = await run16(csms, "CP315-TAMPER", (station) => {
        station.configuration.applyChange("SampledDataSignReadings", "true");
        station.configuration.applyChange(
          "SignedMeterDataMode",
          "tampered_payload",
        );
      });
      const publicKeyDer = hex(
        cp.configuration.get("MeterPublicKey1")?.value as string,
      );
      const stopTx = callsOf(
        csms,
        "StopTransaction",
      )[0][3] as StopTransactionRequestV16;
      for (const d of stopTx.transactionData!) {
        expect(
          await verifies({ ocmf: d.sampledValue[0].value, publicKeyDer }),
        ).toBe(false);
      }
      cp.disconnect();
    } finally {
      await csms.stop();
    }
  });
});

describe.each(["OCPP-2.0.1", "OCPP-2.1"] as const)(
  "%s signed meter values (#315)",
  (version) => {
    it("fills signedMeterValue on Started, Updated, MeterValues and Ended", async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(csms, `CP315-${version}`, version);
        cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
        cp.configuration.applyChange("SampledDataSignReadings", "true");
        cp.startTransaction("TAG-201", 1);
        const event = (type: string) => (f: OcppFrame) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as { eventType?: string }).eventType === type;
        await csms.waitForFrame(event("Started"));
        cp.sendTransactionUpdate(1, {
          triggerReason: "MeterValuePeriodic",
          meterValues: true,
        });
        await csms.waitForFrame(event("Updated"));
        cp.sendMeterValue(1);
        await csms.waitForCall("MeterValues");
        cp.stopTransaction(1);
        await csms.waitForFrame(event("Ended"));

        const signedOf = (payload: {
          meterValue?: TransactionEventRequestV201["meterValue"];
        }) =>
          (payload.meterValue ?? [])
            .flatMap((m) => m.sampledValue)
            .find((s) => s.signedMeterValue)?.signedMeterValue;
        const started = csms.received.find(
          event("Started"),
        )![3] as TransactionEventRequestV201;
        const updated = csms.received.find(
          event("Updated"),
        )![3] as TransactionEventRequestV201;
        const ended = csms.received.find(
          event("Ended"),
        )![3] as TransactionEventRequestV201;
        const mv = callsOf(csms, "MeterValues")[0][3] as {
          meterValue: TransactionEventRequestV201["meterValue"];
        };
        const reasons: string[] = [];
        for (const payload of [started, updated, mv, ended]) {
          const smv = signedOf(payload);
          expect(smv).toMatchObject({
            encodingMethod: "OCMF",
            signingMethod: "ECDSA-secp256r1-SHA256",
          });
          const ocmf = new TextDecoder().decode(b64(smv!.signedMeterData));
          expect(
            await verifies({ ocmf, publicKeyDer: b64(smv!.publicKey) }),
          ).toBe(true);
          reasons.push(reading(ocmf).RD[0].TX);
        }
        expect(reasons).toEqual(["B", "C", "C", "E"]);
        // 2.x reads the switch through its own variable name.
        expect(cp.configuration.get("MeterPublicKey1")?.value).toMatch(/^3059/);
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });
  },
);

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function b64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

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
