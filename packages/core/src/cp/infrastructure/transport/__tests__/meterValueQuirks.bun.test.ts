// #1133 and #1134: two opt-in meter value quirks of a real station, on the wire
// of the golden test's fake CSMS. Without them the golden fixtures pin the
// default wire, which these options must leave unchanged.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Rig } from "../../../../test/goldenWire/rig";
import type { WireVersion } from "../../../../test/goldenWire/FakeCsms";
import { charging, waitCall } from "../../../../test/goldenWire/cases/helpers";
import type { ChargePointTransportOptions } from "../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  OCPP16_WIRE_PROFILE,
  ocpp16WireProfile,
} from "../soap/soapWireProfiles";
import { LogLevel, LogType } from "../../../shared/Logger";
import {
  meterQuirksProblem,
  withDecimalSeparator,
} from "../../../domain/connector/meterQuirks";

const CASE_DEADLINE_MS = 20_000;
setDefaultTimeout(30_000);
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.dispose()));
});

async function chargingRig(
  version: WireVersion,
  transportOptions: ChargePointTransportOptions,
): Promise<Rig> {
  const rig = await Rig.create({
    version,
    transportOptions,
    deadlineMs: CASE_DEADLINE_MS,
  });
  rigs.push(rig);
  await rig.csms.settle();
  await charging(rig);
  return rig;
}

interface WireMeterValue {
  timestamp: string;
  sampledValue: { value: string | number; format?: string }[];
}

const payloadsOf = (rig: Rig, action: string) =>
  rig.csms.frames
    .filter((f) => f.dir === "CP>" && f.action === action)
    .map((f) => f.payload as Record<string, unknown>);

/** Run `send`, then wait for the `action` CALL it causes. */
async function sent(
  rig: Rig,
  action: string,
  send: () => void,
): Promise<Record<string, unknown>> {
  const from = rig.csms.frames.length;
  send();
  await waitCall(rig, action, from);
  return payloadsOf(rig, action).at(-1)!;
}

const valuesOf = (meterValue: unknown) =>
  (meterValue as WireMeterValue[]).flatMap((mv) =>
    mv.sampledValue.map((sv) => String(sv.value)),
  );

describe("meterValueDecimalSeparator (#1133)", () => {
  test('a 1.6 station with "," sends "112,5"-style values in MeterValues and StopTransaction.transactionData', async () => {
    const rig = await chargingRig("1.6", { meterValueDecimalSeparator: "," });
    rig.cp.configuration.applyChange(
      "MeterValuesSampledData",
      "Energy.Active.Import.Register,Current.Import",
    );
    rig.cp.configuration.applyChange("StopTxnSampledData", "Current.Import");

    const meterValues = await sent(rig, "MeterValues", () =>
      rig.cp.sendMeterValue(1),
    );
    const values = valuesOf(meterValues.meterValue);
    // Current.Import always has one decimal; the register is an integer.
    expect(values.some((v) => /^\d+,\d$/.test(v))).toBe(true);
    expect(values.every((v) => !v.includes("."))).toBe(true);

    const stop = await sent(rig, "StopTransaction", () =>
      rig.cp.stopTransaction(1, "Local"),
    );
    const data = valuesOf(stop.transactionData);
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((v) => /^\d+,\d$/.test(v))).toBe(true);
  });

  test("without the option the decimal point stays", async () => {
    const rig = await chargingRig("1.6", {});
    rig.cp.configuration.applyChange(
      "MeterValuesSampledData",
      "Current.Import",
    );
    const meterValues = await sent(rig, "MeterValues", () =>
      rig.cp.sendMeterValue(1),
    );
    expect(
      valuesOf(meterValues.meterValue).every((v) => /^\d+\.\d$/.test(v)),
    ).toBe(true);
  });

  test("a signed reading and a non-numeric value are left alone", () => {
    expect(
      withDecimalSeparator(
        [
          { value: 'OCMF|{"a":1.5}', format: "SignedData" as const },
          { value: "n/a" },
          { value: "-0.25" },
          { value: "42" },
        ],
        ",",
      ).map((s) => s.value),
    ).toEqual(['OCMF|{"a":1.5}', "n/a", "-0,25", "42"]);
  });

  test.each(["OCPP-2.0.1", "OCPP-2.1"])(
    "is refused for a %s station",
    (version) => {
      expect(
        meterQuirksProblem(version, { meterValueDecimalSeparator: "," }),
      ).toContain("OCPP 1.6 only");
      expect(
        meterQuirksProblem(version, { meterValueDecimalSeparator: "." }),
      ).toBeNull();
      expect(() =>
        createChargePoint(
          "CP-1133",
          DefaultBootNotification,
          1,
          "ws://127.0.0.1:1",
          null,
          null,
          null,
          {},
          [],
          version,
          { meterValueDecimalSeparator: "," },
        ),
      ).toThrow("OCPP 1.6 only");
    },
  );

  test("is accepted for OCPP 1.6 JSON and SOAP", () => {
    for (const version of ["OCPP-1.6J", "OCPP-1.6S"]) {
      expect(
        meterQuirksProblem(version, { meterValueDecimalSeparator: "," }),
      ).toBeNull();
    }
  });
});

describe("emptyMeterValues (#1134)", () => {
  test("1.6: a periodic sample of a transaction goes out with sampledValue []", async () => {
    const rig = await chargingRig("1.6", { emptyMeterValues: true });
    const periodic = await sent(rig, "MeterValues", () =>
      rig.cp.sendMeterValue(1),
    );
    const [mv] = periodic.meterValue as WireMeterValue[];
    expect(typeof mv.timestamp).toBe("string");
    expect(mv.sampledValue).toEqual([]);

    // A Trigger reading is not a periodic one: it stays filled.
    const triggered = await sent(rig, "MeterValues", () =>
      rig.cp.sendMeterValue(1, "Trigger"),
    );
    expect(valuesOf(triggered.meterValue).length).toBeGreaterThan(0);
  });

  test("2.0.1: MeterValues and TransactionEvent(Updated) carry sampledValue [], and the schema warning is logged", async () => {
    const rig = await chargingRig("2.0.1", { emptyMeterValues: true });
    const warnings: string[] = [];
    rig.cp.logger.setEnabledTypes(LogType.OCPP);
    rig.cp.logger.on("log", (e) => {
      if (e.level === LogLevel.WARN && e.message.includes("sampledValue"))
        warnings.push(e.message);
    });

    const clock = await sent(rig, "MeterValues", () =>
      rig.cp.sendMeterValue(1, "Sample.Clock"),
    );
    expect((clock.meterValue as WireMeterValue[])[0].sampledValue).toEqual([]);

    const updated = await sent(rig, "TransactionEvent", () =>
      rig.cp.sendTransactionUpdate(1, {
        triggerReason: "MeterValuePeriodic",
        context: "Sample.Periodic",
        meterValues: true,
      }),
    );
    expect(updated.triggerReason).toBe("MeterValuePeriodic");
    expect((updated.meterValue as WireMeterValue[])[0].sampledValue).toEqual(
      [],
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("2.0.1 without the option the samples stay filled", async () => {
    const rig = await chargingRig("2.0.1", {});
    const meterValues = await sent(rig, "MeterValues", () =>
      rig.cp.sendMeterValue(1),
    );
    expect(valuesOf(meterValues.meterValue).length).toBeGreaterThan(0);
  });
});

describe("OCPP 1.6 SOAP profile (#1133, #1134)", () => {
  const samples = [
    {
      value: "16.5",
      context: "Sample.Periodic" as const,
      measurand: "Current.Import",
    },
  ];
  const at = new Date("2030-01-01T00:00:00Z");
  const sampledValueOf = (payload: unknown) =>
    JSON.stringify(payload).match(/"sampledValue":(\[[^\]]*\])/)?.[1];

  test("spells the values with the station's separator", () => {
    const profile = ocpp16WireProfile({
      decimalSeparator: ",",
      emptyMeterValues: false,
    });
    expect(
      sampledValueOf(profile.toMeterValuesRequest(1, 7, samples, at)),
    ).toContain('"16,5"');
  });

  test("empties a transaction's periodic sample, not an idle one", () => {
    const profile = ocpp16WireProfile({
      decimalSeparator: ".",
      emptyMeterValues: true,
    });
    expect(
      sampledValueOf(profile.toMeterValuesRequest(1, 7, samples, at)),
    ).toBe("[]");
    expect(
      sampledValueOf(profile.toMeterValuesRequest(1, undefined, samples, at)),
    ).toContain('"16.5"');
  });

  test("is the plain profile without quirks", () => {
    expect(
      ocpp16WireProfile({ decimalSeparator: ".", emptyMeterValues: false }),
    ).toBe(OCPP16_WIRE_PROFILE);
  });
});
