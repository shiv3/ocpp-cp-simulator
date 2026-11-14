import { describe, expect, it } from "vitest";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { defaultConfiguration } from "../../../../domain/charge-point/Configuration";
import { ConfigurationStore } from "../../../../domain/charge-point/ConfigurationStore";
import { RUNTIME_VALUE_KEYS } from "../../../../domain/charge-point/runtimeValueKeys";
import { DEVICE_MODEL } from "../../../../domain/device-model/DeviceModelRegistry";
import { LocalAuthListManager } from "../../../../domain/auth/LocalAuthList";
import { makeChargePoint } from "../../../../domain/charge-point/__tests__/chargePointFixtures";
import { MonitoringStore } from "../../../../domain/monitoring/MonitoringStore";
import { buildOcppWebSocketConnectOptions } from "../../wsUrlWithBasic";
import { handleSetVariableMonitoringV201 } from "../variableMonitoringV201";
import { buildBaseReportData } from "../baseReportV201";
import { handleGetVariablesV201 } from "../getVariablesV201";
import { handleSetVariablesV201 } from "../setVariablesV201";

/**
 * #704: the variables Part 2 §2 marks "Required yes" for the controllers the
 * simulator implements are registered, or declined below with a reason.
 */
const REQUIRED: ReadonlyArray<[string, string]> = [
  ["SecurityCtrlr", "SecurityProfile"],
  ["SecurityCtrlr", "OrganizationName"],
  ["OCPPCommCtrlr", "OfflineThreshold"],
  ["OCPPCommCtrlr", "FileTransferProtocols"],
  ["OCPPCommCtrlr", "UnlockOnEVSideDisconnect"],
  ["ClockCtrlr", "DateTime"],
  ["ClockCtrlr", "TimeSource"],
  ["LocalAuthListCtrlr", "Entries"],
  ["SecurityCtrlr", "BasicAuthPassword"],
];

/** Required by the spec, declined with the reason. */
const DECLINED: Record<string, string> = {
  "OCPPCommCtrlr/NetworkConfigurationPriority": "network profiles → #569",
  "OCPPCommCtrlr/ActiveNetworkProfile": "network profiles → #569",
  "OCPPCommCtrlr/NetworkProfileConnectionAttempts": "network profiles → #569",
};

const store = (version = "OCPP-2.0.1") => {
  const cp = {
    connectorNumber: 1,
    wsUrl: "ws://csms.example/ocpp/",
    ocppVersion: version,
  } as ChargePoint;
  const s = new ConfigurationStore(defaultConfiguration(cp), null);
  // Published by the ChargePoint on 2.x.
  for (const v of DEVICE_MODEL.variables) {
    if (v.constant === true && typeof v.default === "string") {
      s.defineRuntimeKey(v.valueKey, v.default);
    }
  }
  s.defineLiveKey(RUNTIME_VALUE_KEYS.clockDateTime, () =>
    new Date().toISOString(),
  );
  s.defineRuntimeIntegerKey(RUNTIME_VALUE_KEYS.localAuthListEntries, 0, {
    min: 0,
  });
  return s;
};

const get = (s: ConfigurationStore, component: string, variable: string) =>
  handleGetVariablesV201(
    {
      getVariableData: [
        { component: { name: component }, variable: { name: variable } },
      ],
    },
    s,
  ).getVariableResult[0];

describe("required device-model variables (#704)", () => {
  it("registers every required variable or declines it with a reason", () => {
    for (const [c, v] of REQUIRED) {
      expect(DEVICE_MODEL.find(c, v), `${c}.${v}`).toBeDefined();
    }
    for (const reason of Object.values(DECLINED)) {
      expect(reason).toBeTruthy();
    }
    for (const id of Object.keys(DECLINED)) {
      const [c, v] = id.split("/");
      expect(DEVICE_MODEL.find(c, v), id).toBeUndefined();
    }
  });

  it("answers GetVariables for each, in the report, with the right mutability", () => {
    const s = store();
    const report = buildBaseReportData(s);
    for (const [c, v] of REQUIRED) {
      const def = DEVICE_MODEL.find(c, v);
      const res = get(s, c, v);
      if (def?.mutability === "WriteOnly") {
        expect(res.attributeStatus, `${c}.${v}`).toBe("Rejected");
      } else {
        expect(res.attributeStatus, `${c}.${v}`).toBe("Accepted");
      }
      const datum = report.find(
        (r) => r.component.name === c && r.variable.name === v,
      );
      expect(datum, `${c}.${v} in report`).toBeDefined();
      expect(datum?.variableAttribute[0].mutability).toBe(def?.mutability);
    }
  });

  it("is spec-conformant by default", () => {
    const s = store();
    expect(get(s, "SecurityCtrlr", "SecurityProfile").attributeValue).toBe("0");
    expect(get(s, "ClockCtrlr", "TimeSource").attributeValue).toBe("Heartbeat");
    expect(
      get(s, "OCPPCommCtrlr", "FileTransferProtocols").attributeValue,
    ).toBe("HTTP,HTTPS");
    const dt = get(s, "ClockCtrlr", "DateTime").attributeValue ?? "";
    expect(Number.isNaN(Date.parse(dt))).toBe(false);
  });

  it("keeps the ones without behavior ReadOnly", () => {
    const s = store();
    for (const v of [
      ["SecurityCtrlr", "SecurityProfile", "1"],
      ["SecurityCtrlr", "OrganizationName", "x"],
      ["OCPPCommCtrlr", "UnlockOnEVSideDisconnect", "false"],
      ["ClockCtrlr", "TimeSource", "NTP"],
      ["LocalAuthListCtrlr", "Entries", "3"],
    ]) {
      const res = handleSetVariablesV201(
        {
          setVariableData: [
            {
              component: { name: v[0] },
              variable: { name: v[1] },
              attributeValue: v[2],
            },
          ],
        },
        s,
      );
      expect(res.setVariableResult[0].attributeStatus, v[1]).toBe("Rejected");
    }
  });

  it("stores BasicAuthPassword, never returns it, and tells the listeners", () => {
    const s = store();
    const seen: Array<[string, unknown]> = [];
    s.onChange((k, v) => seen.push([k, v]));
    const password = "0123456789abcdef0123456789abcdef";
    const res = handleSetVariablesV201(
      {
        setVariableData: [
          {
            component: { name: "SecurityCtrlr" },
            variable: { name: "BasicAuthPassword" },
            attributeValue: password,
          },
        ],
      },
      s,
    );
    expect(res.setVariableResult[0].attributeStatus).toBe("Accepted");
    expect(s.getString("AuthorizationKey")).toBe(password);
    expect(seen).toContainEqual(["AuthorizationKey", password]);
    const read = get(s, "SecurityCtrlr", "BasicAuthPassword");
    expect(JSON.stringify(read)).not.toContain(password);
    expect(JSON.stringify(buildBaseReportData(s))).not.toContain(password);
  });

  it("counts the local list entries", () => {
    const m = new LocalAuthListManager({
      info: () => {},
      warn: () => {},
    } as never);
    const s = store();
    m.onChange((n) =>
      s.setRuntimeValue(RUNTIME_VALUE_KEYS.localAuthListEntries, n),
    );
    m.applyFull(1, [{ idTag: "A", idTagInfo: { status: "Accepted" } }], {
      sendLocalListMaxLength: 10,
      localAuthListMaxLength: 10,
    });
    expect(get(s, "LocalAuthListCtrlr", "Entries").attributeValue).toBe("1");
  });

  describe("BasicAuthPassword on 2.x (#704)", () => {
    /** A 2.x station on security profile 1, where the guard is active. */
    const profile1Station = (id?: string) => {
      const cp = makeChargePoint({
        ...(id !== undefined && { id }),
        ocppVersion: "OCPP-2.0.1",
      });
      cp.configuration.applyChange("SecurityProfile", "1", {
        bypassGuard: true,
      });
      return cp;
    };
    const setPassword = (cp: ReturnType<typeof makeChargePoint>, v: string) =>
      handleSetVariablesV201(
        {
          setVariableData: [
            {
              component: { name: "SecurityCtrlr" },
              variable: { name: "BasicAuthPassword" },
              attributeValue: v,
            },
          ],
        },
        cp.configuration,
      ).setVariableResult[0].attributeStatus;

    it.each([
      "0123456789abcdef0123456789abcdef", // 32 hex chars: a literal password
      "correct horse battery staple".replace(/ /g, "-"), // 28 non-hex chars
      "x".repeat(40),
      "y".repeat(16),
    ])("sends %s as-is in the next connection's Basic header", (password) => {
      const cp = profile1Station("CP-2x");
      try {
        expect(setPassword(cp, password)).toBe("Accepted");
        const opts = buildOcppWebSocketConnectOptions({
          baseUrl: "wss://csms.example/ocpp/",
          chargePointId: "CP-2x",
          basicAuth: null,
          ocppVersion: "OCPP-2.0.1",
          securityProfile: 1,
          authorizationKey: cp.configuration.getString("AuthorizationKey"),
        });
        expect(opts.headers.Authorization).toBe(
          `Basic ${btoa(`CP-2x:${password}`)}`,
        );
      } finally {
        cp.dispose();
      }
    });

    it("refuses a password outside 16-40 printable characters", () => {
      const cp = profile1Station();
      try {
        expect(setPassword(cp, "short")).toBe("Rejected");
        expect(setPassword(cp, "z".repeat(41))).toBe("Rejected");
        expect(setPassword(cp, "has a space inside it")).toBe("Rejected");
      } finally {
        cp.dispose();
      }
    });

    it("reports maxLimit 40 and no monitoring support", () => {
      const rd = buildBaseReportData(store()).find(
        (r) => r.variable.name === "BasicAuthPassword",
      );
      expect(rd?.variableCharacteristics?.maxLimit).toBe(40);
      expect(rd?.variableCharacteristics?.supportsMonitoring).toBe(false);
    });

    it("refuses SetVariableMonitoring on it", () => {
      const res = handleSetVariableMonitoringV201(
        {
          setMonitoringData: [
            {
              type: "Delta",
              severity: 5,
              value: 1,
              component: { name: "SecurityCtrlr" },
              variable: { name: "BasicAuthPassword" },
            },
          ],
        },
        new MonitoringStore(),
        store(),
        {},
      );
      expect(res.setMonitoringResult[0].status).toBe("UnsupportedMonitorType");
    });
  });
});
