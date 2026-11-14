import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyReportRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import { handleGetBaseReportV201 } from "../../../infrastructure/transport/v201/inboundRegistryV201";
import { handleSetVariablesV201 } from "../../../infrastructure/transport/v201/setVariablesV201";
import { ChangeConfigurationHandler } from "../../../infrastructure/transport/handlers/call/OtherCallHandlers";
import type { Logger } from "../../../shared/Logger";
import { DEVICE_MODEL } from "../../device-model/DeviceModelRegistry";
import type { ChargePoint } from "../ChargePoint";
import { defaultConfiguration } from "../Configuration";
import { ConfigurationStore } from "../ConfigurationStore";
import {
  ConfigurationWriteRejectedError,
  readConfigurationKeys,
  writeConfigurationKey,
} from "../configurationAccess";
import { makeChargePoint } from "./chargePointFixtures";

// #922: the custom key AuthorizeRemoteTxRequestsReadOnly chooses the
// accessibility of AuthorizeRemoteTxRequests / AuthCtrlr.AuthorizeRemoteStart.
const RO = "AuthorizeRemoteTxRequestsReadOnly";
const KEY = "AuthorizeRemoteTxRequests";

const stations: ChargePoint[] = [];
afterEach(() => {
  for (const s of stations.splice(0)) s.dispose();
});
const station = (ocppVersion: string): ChargePoint => {
  const cp = makeChargePoint({ ocppVersion });
  stations.push(cp);
  return cp;
};
const store = (ocppVersion = "OCPP-1.6J") =>
  new ConfigurationStore(
    defaultConfiguration({
      connectorNumber: 1,
      wsUrl: "ws://x/",
      ocppVersion,
    } as ChargePoint),
  );

describe("AuthorizeRemoteTxRequestsReadOnly (#922)", () => {
  it("defaults to false: the key is read-write as before", () => {
    const s = store();
    expect(s.getBoolean(RO)).toBe(false);
    expect(s.get(KEY)?.key.readonly).toBe(false);
    expect(s.applyChange(KEY, "true")).toBe("Accepted");
  });

  it("applies at once: the CSMS write is Rejected, then accepted again", () => {
    const s = store();
    expect(s.applyChange(RO, "true")).toBe("Accepted");
    expect(s.get(KEY)?.key.readonly).toBe(true);
    expect(s.applyChange(KEY, "true")).toBe("Rejected");
    expect(s.authorizeRemoteTxRequests()).toBe(false);
    expect(s.applyChange(RO, "false")).toBe("Accepted");
    expect(s.applyChange(KEY, "true")).toBe("Accepted");
  });

  it("is not itself a read-only key, and no other read-only key opens up", () => {
    const s = store();
    expect(s.get(RO)?.key.readonly).toBe(false);
    expect(
      s.applyChange("GetConfigurationMaxKeys", "5", { operator: true }),
    ).toBe("Rejected");
  });

  describe.each([
    ["OCPP 1.6", "OCPP-1.6J", false],
    ["OCPP 2.x", "OCPP-2.0.1", true],
  ])("%s operator access", (_, version, is2x) => {
    it("still writes the value while it is read-only for the CSMS, and reports it read-only", () => {
      const s = store(version);
      s.applyChange(RO, "true");
      const { keys } = readConfigurationKeys(s, is2x, [KEY]);
      expect(keys[0]).toMatchObject({ readonly: true });
      if (is2x) expect(keys[0]?.mutability).toBe("ReadOnly");
      expect(writeConfigurationKey(s, is2x, KEY, "true")).toBe("Accepted");
      expect(s.authorizeRemoteTxRequests()).toBe(true);
      // The CSMS still cannot change it back.
      expect(s.applyChange(KEY, "false")).toBe("Rejected");
    });

    it("never opens a genuinely read-only key", () => {
      expect(() =>
        writeConfigurationKey(
          store(version),
          is2x,
          "SendLocalListMaxLength",
          "5",
        ),
      ).toThrow(ConfigurationWriteRejectedError);
    });
  });

  it("1.6: ChangeConfiguration is Rejected and GetConfiguration reports readonly", () => {
    const cp = station("OCPP-1.6J");
    cp.configuration.applyChange(RO, "true");
    const handle = (value: string) =>
      new ChangeConfigurationHandler().handle({ key: KEY, value }, {
        chargePoint: cp,
        logger: { info() {} } as unknown as Logger,
      } as never);
    expect(handle("true")).toEqual({ status: "Rejected" });
    expect(cp.configuration.read([KEY]).known[0]?.key.readonly).toBe(true);
  });

  it("2.x: SetVariables is Rejected / ReadOnly, then ReadWrite again", () => {
    const cp = station("OCPP-2.0.1");
    const set = () =>
      handleSetVariablesV201(
        {
          setVariableData: [
            {
              attributeValue: "true",
              component: { name: "AuthCtrlr" },
              variable: { name: "AuthorizeRemoteStart" },
            },
          ],
        },
        cp.configuration,
      ).setVariableResult[0];
    cp.configuration.applyChange(RO, "true");
    expect(set()).toMatchObject({
      attributeStatus: "Rejected",
      attributeStatusInfo: { reasonCode: "ReadOnly" },
    });
    expect(cp.configuration.authorizeRemoteTxRequests()).toBe(false);
    cp.configuration.applyChange(RO, "false");
    expect(set()?.attributeStatus).toBe("Accepted");
  });

  it("2.x: GetBaseReport reports the per-station mutability", () => {
    const cp = station("OCPP-2.0.1");
    const mutability = (): string | undefined => {
      const sendCall = vi.fn();
      handleGetBaseReportV201(
        { requestId: 1, reportBase: "FullInventory" },
        { chargePoint: cp, logger: {} as Logger, sendCall },
      ).afterResult?.();
      return sendCall.mock.calls
        .flatMap((c) => (c[1] as NotifyReportRequestV201).reportData ?? [])
        .find(
          (rd) =>
            rd.component.name === "AuthCtrlr" &&
            rd.variable.name === "AuthorizeRemoteStart",
        )?.variableAttribute[0]?.mutability;
    };
    expect(mutability()).toBe("ReadWrite");
    cp.configuration.applyChange(RO, "true");
    expect(mutability()).toBe("ReadOnly");
  });

  it("keeps the registry default equal to the store default (parity)", () => {
    const def = DEVICE_MODEL.byValueKey(KEY);
    expect(def?.mutability).toBe("ReadWrite");
    expect(store("OCPP-2.0.1").get(KEY)?.key.readonly).toBe(false);
    // The custom key is a station choice, not a Device Model variable.
    expect(DEVICE_MODEL.byValueKey(RO)).toBeUndefined();
  });
});
