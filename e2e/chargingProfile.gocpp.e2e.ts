import { afterAll, beforeAll, expect, test } from "bun:test";
import { ChargePoint } from "../src/cp/domain/charge-point/ChargePoint";
import { getDefaultEVSettings } from "../src/cp/domain/connector/EVSettings";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../src/cp/domain/types/OcppTypes";
import {
  startCsms,
  stopAllCsms,
  type CommandResponse,
  type CsmsHandle,
} from "./support/gocppCsms";
import type { Frame } from "./support/frameLog";

/**
 * OCPP 1.6 smart charging against a real CSMS (gocpp, #323): an ampere
 * limit reaches the MeterValues the CSMS receives, ClearChargingProfile
 * lifts it, and GetCompositeSchedule restates the profile in its own unit
 * and phase count.
 *
 * The connector is AC, 3 phases, 230 V, cos φ 0.9, so a 6 A limit is
 * 6 × 230 × 3 × 0.9 = 3726 W on three phases and 6 × 230 × 0.9 = 1242 W
 * on one; `Current.Import` reads 6.0 A — the per-phase line current — in
 * both cases.
 */

const OCPP_VERSION = "OCPP-1.6J";
const WAIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const CONNECTOR_ID = 1;
const PROFILE_ID = 323;

let csms: CsmsHandle;

beforeAll(async () => {
  csms = await startCsms(OCPP_VERSION);
});

afterAll(async () => {
  await stopAllCsms();
});

function makeChargePoint(cpId: string): ChargePoint {
  const cp = new ChargePoint(
    cpId,
    DefaultBootNotification,
    1,
    csms.ocppUrl,
    null,
    null,
    null,
    {},
    [],
    OCPP_VERSION,
    {},
  );
  // Keep e2e output focused on assertions; wire evidence comes from FrameLog.
  cp.logger.setEnabledTypes();
  cp.events.on("error", () => undefined);
  cp.getConnector(CONNECTOR_ID)!.evSettings = {
    ...getDefaultEVSettings(),
    currentType: "AC",
    phases: 3,
    voltageV: 230,
    powerFactor: 0.9,
  };
  cp.configuration.applyChange(
    "MeterValuesSampledData",
    "Current.Import,Power.Active.Import",
  );
  return cp;
}

async function waitUntil(
  pred: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (pred()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function lastSeq(cpId: string): number {
  const frames = csms.frames.byCp(cpId);
  return frames.length === 0 ? 0 : frames[frames.length - 1].seq;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertCommandOk(response: CommandResponse): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(response.error ?? "CSMS command failed");
  }
  if (!isRecord(response.result)) {
    throw new Error("Expected the CSMS command result to be an object");
  }
  return response.result;
}

/** Boot, then start a transaction and wait until the connector charges. */
async function charging(cp: ChargePoint, cpId: string): Promise<number> {
  await cp.connect();
  await csms.frames.waitForCall("BootNotification", {
    cpId,
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await waitUntil(
    () => cp.getConnector(CONNECTOR_ID)?.status === OCPPStatus.Available,
  );
  cp.startTransaction("TAG-OK", CONNECTOR_ID);
  let transactionId = 0;
  await waitUntil(() => {
    const id = cp.getConnector(CONNECTOR_ID)?.transaction?.id;
    if (typeof id === "number" && id > 0) transactionId = id;
    return (
      transactionId > 0 &&
      cp.getConnector(CONNECTOR_ID)?.status === OCPPStatus.Charging
    );
  });
  return transactionId;
}

interface Reading {
  power: string;
  current: string;
}

/**
 * Ask for a sample and return the whole-connector `Power.Active.Import` and
 * `Current.Import` the CSMS received (the samples without a `phase`).
 */
async function meterReading(cp: ChargePoint, cpId: string): Promise<Reading> {
  const sinceSeq = lastSeq(cpId);
  cp.sendMeterValue(CONNECTOR_ID);
  const frame: Frame = await csms.frames.waitForFrame(
    (f) =>
      f.cpId === cpId &&
      f.action === "MeterValues" &&
      f.seq > sinceSeq &&
      isRecord(f.payload),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
  const payload = frame.payload as {
    meterValue: { sampledValue: Record<string, unknown>[] }[];
  };
  const samples = payload.meterValue.flatMap((mv) => mv.sampledValue);
  const aggregate = (measurand: string): string => {
    const sample = samples.find(
      (s) => s.measurand === measurand && s.phase === undefined,
    );
    if (!sample) throw new Error(`No ${measurand} sample in MeterValues`);
    return String(sample.value);
  };
  return {
    power: aggregate("Power.Active.Import"),
    current: aggregate("Current.Import"),
  };
}

async function setAmpProfile(
  cpId: string,
  transactionId: number,
  period: { limit: number; numberPhases?: number },
): Promise<void> {
  const result = assertCommandOk(
    await csms.command({
      cpId,
      action: "SetChargingProfile",
      connectorId: CONNECTOR_ID,
      csChargingProfiles: {
        chargingProfileId: PROFILE_ID,
        stackLevel: 1,
        chargingProfilePurpose: "TxProfile",
        chargingProfileKind: "Relative",
        transactionId,
        chargingSchedule: {
          chargingRateUnit: "A",
          chargingSchedulePeriod: [{ startPeriod: 0, ...period }],
        },
      },
    }),
  );
  expect(result.status).toBe("Accepted");
}

async function compositePeriods(
  cpId: string,
  chargingRateUnit: "A" | "W",
): Promise<unknown[]> {
  const result = assertCommandOk(
    await csms.command({
      cpId,
      action: "GetCompositeSchedule",
      connectorId: CONNECTOR_ID,
      duration: 3600,
      chargingRateUnit,
    }),
  );
  expect(result.status).toBe("Accepted");
  const schedule = result.chargingSchedule as {
    chargingRateUnit: string;
    chargingSchedulePeriod: unknown[];
  };
  expect(schedule.chargingRateUnit).toBe(chargingRateUnit);
  return schedule.chargingSchedulePeriod;
}

test(
  "a 6 A profile on 3 phases caps MeterValues, restates in GetCompositeSchedule, and clears",
  async () => {
    const cpId = "cp16-profile-3ph";
    const cp = makeChargePoint(cpId);

    try {
      const transactionId = await charging(cp, cpId);
      await setAmpProfile(cpId, transactionId, { limit: 6 });

      expect(await meterReading(cp, cpId)).toEqual({
        power: "3726",
        current: "6.0",
      });
      // The period states no numberPhases, so none comes back.
      expect(await compositePeriods(cpId, "A")).toEqual([
        { startPeriod: 0, limit: 6 },
      ]);

      const cleared = assertCommandOk(
        await csms.command({
          cpId,
          action: "ClearChargingProfile",
          id: PROFILE_ID,
        }),
      );
      expect(cleared.status).toBe("Accepted");

      const lifted = await meterReading(cp, cpId);
      expect(Number(lifted.power)).toBeGreaterThan(3726);
      expect(Number(lifted.current)).toBeGreaterThan(6);
      expect(await compositePeriods(cpId, "A")).toEqual([]);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a 6 A profile with numberPhases 1 draws on one phase and round-trips its phase count",
  async () => {
    const cpId = "cp16-profile-1ph";
    const cp = makeChargePoint(cpId);

    try {
      const transactionId = await charging(cp, cpId);
      await setAmpProfile(cpId, transactionId, { limit: 6, numberPhases: 1 });

      expect(await meterReading(cp, cpId)).toEqual({
        power: "1242",
        current: "6.0",
      });
      expect(await compositePeriods(cpId, "A")).toEqual([
        { startPeriod: 0, limit: 6, numberPhases: 1 },
      ]);
      // The other unit converts at 230 V on the period's own phase count.
      expect(await compositePeriods(cpId, "W")).toEqual([
        { startPeriod: 0, limit: 1380, numberPhases: 1 },
      ]);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);
