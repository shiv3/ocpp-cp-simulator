import { describe, it, expect } from "bun:test";
import { startMockCsms } from "./mockCsms";
import { bootedChargePoint } from "./stationHarness";

// OCPP-J 2.0.1 / 2.1 Part 4 §4.3 Table 8: the error code of an invalid inbound
// payload names the kind of violation (#715).
const CASES: ReadonlyArray<{
  name: string;
  action: string;
  payload: unknown;
  code: string;
}> = [
  {
    name: "missing required property",
    action: "SetVariables",
    payload: {},
    code: "OccurrenceConstraintViolation",
  },
  {
    name: "empty array below minItems",
    action: "SetVariables",
    payload: { setVariableData: [] },
    code: "OccurrenceConstraintViolation",
  },
  {
    name: "wrong JSON type",
    action: "ChangeAvailability",
    payload: { operationalStatus: 5 },
    code: "TypeConstraintViolation",
  },
  {
    name: "value outside the enum",
    action: "ChangeAvailability",
    payload: { operationalStatus: "Nope" },
    code: "PropertyConstraintViolation",
  },
  {
    name: "unknown property",
    action: "UnlockConnector",
    payload: { evseId: 1, connectorId: 1, extra: "x" },
    code: "FormatViolation",
  },
  {
    name: "payload that is not an object",
    action: "ClearCache",
    payload: "nope",
    code: "FormatViolation",
  },
];

// 2.1-only actions have no 2.0.1 schema: classifying against it gave every
// violation FormatViolation (#750).
const CASES_V21: typeof CASES = [
  {
    name: "2.1-only action, missing required property",
    action: "AFRRSignal",
    payload: {},
    code: "OccurrenceConstraintViolation",
  },
  {
    name: "2.1-only action, wrong JSON type",
    action: "ClearTariffs",
    payload: { tariffIds: 5 },
    code: "TypeConstraintViolation",
  },
];

for (const version of ["OCPP-2.0.1", "OCPP-2.1"]) {
  describe(`${version} inbound payload violations (#715)`, () => {
    for (const c of version === "OCPP-2.1" ? [...CASES, ...CASES_V21] : CASES) {
      it(`${c.name} -> ${c.code}`, async () => {
        const csms = startMockCsms();
        const cp = await bootedChargePoint(csms, "CP715", version);
        try {
          csms.send([2, "v-1", c.action, c.payload]);
          const frame = await csms.waitForFrame(
            (f) => f[0] === 4 && f[1] === "v-1",
          );
          expect(frame[2]).toBe(c.code);
          expect(String(frame[3]).length).toBeLessThanOrEqual(255);
        } finally {
          cp.disconnect();
          await csms.stop();
        }
      });
    }
  });
}
