import { afterEach, describe, expect, it } from "vitest";
import type { SetNetworkProfileRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import { isValidSetNetworkProfileResponseV201 } from "@ocpp-cp-simulator/ocpp/v201/validators";
import { isValidSetNetworkProfileResponseV21 } from "@ocpp-cp-simulator/ocpp/v21/validators";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { makeChargePoint } from "../../../../domain/charge-point/__tests__/chargePointFixtures";
import type { Logger } from "../../../../shared/Logger";
import { handleSetNetworkProfileAckV201 } from "../csmsAcksV201";
import { handleSetVariablesV201 } from "../setVariablesV201";
import { handleGetVariablesV201 } from "../getVariablesV201";

// B09 SetNetworkProfile: validated, stored in its slot, never a reconnect.
// The 2.1 registry reuses the 2.0.1 handler, so both versions run it.
describe.each([
  ["OCPP-2.0.1", isValidSetNetworkProfileResponseV201],
  ["OCPP-2.1", isValidSetNetworkProfileResponseV21],
] as const)("%s SetNetworkProfile", (ocppVersion, isValidResponse) => {
  const stations: ChargePoint[] = [];
  afterEach(() => {
    for (const s of stations.splice(0)) s.dispose();
  });
  const station = (securityProfile = 0) => {
    const cp = makeChargePoint({ ocppVersion });
    stations.push(cp);
    cp.configuration.applyChange("SecurityProfile", String(securityProfile), {
      bypassGuard: true,
    });
    return cp;
  };
  const request = (
    over: Partial<SetNetworkProfileRequestV201["connectionData"]> = {},
    configurationSlot = 1,
  ): SetNetworkProfileRequestV201 => ({
    configurationSlot,
    connectionData: {
      ocppVersion: "OCPP20",
      ocppTransport: "JSON",
      ocppCsmsUrl: "wss://csms.example/ocpp/",
      messageTimeout: 30,
      securityProfile: 2,
      ocppInterface: "Wired0",
      ...over,
    },
  });
  const send = (cp: ChargePoint, req: SetNetworkProfileRequestV201) => {
    const { response } = handleSetNetworkProfileAckV201(req, {
      chargePoint: cp,
      logger: {} as Logger,
      sendCall: () => {},
    });
    expect(isValidResponse(response)).toBe(true);
    return response as {
      status: string;
      statusInfo?: { reasonCode: string };
    };
  };

  it("accepts a valid profile and stores it in the slot without reconnecting (B09.FR.02)", () => {
    const cp = station(1);
    const wsUrlBefore = cp.wsUrl;
    const securityProfileBefore =
      cp.configuration.getInteger("SecurityProfile");
    expect(send(cp, request())).toEqual({ status: "Accepted" });
    expect(cp.networkProfiles.get(1)?.ocppCsmsUrl).toBe(
      "wss://csms.example/ocpp/",
    );
    // The connection settings in force are untouched.
    expect(cp.wsUrl).toBe(wsUrlBefore);
    expect(cp.configuration.getInteger("SecurityProfile")).toBe(
      securityProfileBefore,
    );
  });

  it("rejects invalid content with statusInfo.reasonCode and stores nothing (B09.FR.01)", () => {
    const cp = station();
    expect(send(cp, request({ ocppTransport: "SOAP" }))).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "UnsupportedParam" },
    });
    expect(
      send(cp, request({ ocppCsmsUrl: "ws://csms.example/" })),
    ).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "InvalidNetworkConf" },
    });
    expect(send(cp, request({}, 99))).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "InvalidConfSlot" },
    });
    expect(cp.networkProfiles.slots()).toEqual([]);
  });

  it("enforces SecurityCtrlr.AllowSecurityProfileDowngrade (B09.FR.04)", () => {
    const cp = station(3);
    const allow = (v: string) =>
      handleSetVariablesV201(
        {
          setVariableData: [
            {
              component: { name: "SecurityCtrlr" },
              variable: { name: "AllowSecurityProfileDowngrade" },
              attributeValue: v,
            },
          ],
        },
        cp.configuration,
      ).setVariableResult[0].attributeStatus;
    const read = handleGetVariablesV201(
      {
        getVariableData: [
          {
            component: { name: "SecurityCtrlr" },
            variable: { name: "AllowSecurityProfileDowngrade" },
          },
        ],
      },
      cp.configuration,
    ).getVariableResult[0];
    expect(read.attributeValue).toBe("false");

    expect(send(cp, request({ securityProfile: 2 }))).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "NoSecurityDowngrade" },
    });
    expect(allow("true")).toBe("Accepted");
    expect(send(cp, request({ securityProfile: 2 }))).toEqual({
      status: "Accepted",
    });
    // Still never below 2.
    expect(
      send(
        cp,
        request({ securityProfile: 1, ocppCsmsUrl: "wss://csms.example/" }, 2),
      ),
    ).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "NoSecurityDowngrade" },
    });
  });
});
