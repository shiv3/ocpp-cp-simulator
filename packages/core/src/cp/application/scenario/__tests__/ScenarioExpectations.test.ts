import { describe, expect, it } from "vitest";
import { deriveExpectation } from "../ScenarioExpectations";
import {
  ScenarioNodeType,
  type ScenarioNode,
  type ScenarioNodeData,
} from "../ScenarioTypes";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

function node(type: ScenarioNodeType, data: ScenarioNodeData): ScenarioNode {
  return { id: `${type}-1`, type, position: { x: 0, y: 0 }, data };
}

describe("deriveExpectation (#179)", () => {
  const connectorId = 1;

  it("remoteStartTrigger → ocpp_call RemoteStartTransaction (CSMS→CP)", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.REMOTE_START_TRIGGER, {
        label: "Wait for RemoteStart",
        timeout: 30,
      } as ScenarioNodeData),
      connectorId,
    );
    expect(exp).toEqual({
      type: "ocpp_call",
      direction: "CSMS_TO_CP",
      action: "RemoteStartTransaction",
      constraints: { connectorId: 1 },
      timeoutMs: 30000,
      nodeId: "remoteStartTrigger-1",
    });
  });

  it("remoteStopTrigger → ocpp_call RemoteStopTransaction", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.REMOTE_STOP_TRIGGER, {
        label: "Wait for RemoteStop",
      } as ScenarioNodeData),
      connectorId,
    );
    expect(exp?.action).toBe("RemoteStopTransaction");
    expect(exp?.type).toBe("ocpp_call");
    // timeout absent/0 → no timeoutMs (wait forever)
    expect(exp?.timeoutMs).toBeUndefined();
  });

  it("csmsCallTrigger → ocpp_call with the node's action", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.CSMS_CALL_TRIGGER, {
        label: "Wait for GetConfiguration",
        action: "GetConfiguration",
        timeout: 15,
      } as ScenarioNodeData),
      connectorId,
    );
    expect(exp).toMatchObject({
      type: "ocpp_call",
      direction: "CSMS_TO_CP",
      action: "GetConfiguration",
      timeoutMs: 15000,
    });
  });

  it("statusTrigger → connector_status with targetStatus", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.STATUS_TRIGGER, {
        label: "Wait for Available",
        targetStatus: OCPPStatus.Available,
        timeout: 30,
      } as ScenarioNodeData),
      connectorId,
    );
    expect(exp).toMatchObject({
      type: "connector_status",
      targetStatus: "Available",
      constraints: { connectorId: 1 },
      timeoutMs: 30000,
    });
    expect(exp?.action).toBeUndefined();
  });

  it("reservationTrigger → reservation / ReserveNow", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.RESERVATION_TRIGGER, {
        label: "Wait for ReserveNow",
      } as ScenarioNodeData),
      connectorId,
    );
    expect(exp).toMatchObject({
      type: "reservation",
      direction: "CSMS_TO_CP",
      action: "ReserveNow",
    });
  });

  it("includes the payload subset in csmsCallTrigger constraints (#240)", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.CSMS_CALL_TRIGGER, {
        label: "wait",
        action: "ChangeConfiguration",
        payload: { key: "HeartbeatInterval" },
        timeout: 5,
      } as ScenarioNodeData),
      1,
    );
    expect(exp).toEqual({
      type: "ocpp_call",
      direction: "CSMS_TO_CP",
      action: "ChangeConfiguration",
      constraints: { connectorId: 1, payload: { key: "HeartbeatInterval" } },
      timeoutMs: 5000,
      nodeId: "csmsCallTrigger-1",
    });
  });

  it("keeps csmsCallTrigger constraints payload-only when no connector is bound", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.CSMS_CALL_TRIGGER, {
        label: "wait",
        action: "Reset",
        payload: { type: "Hard" },
      } as ScenarioNodeData),
      undefined,
    );
    expect(exp).toEqual({
      type: "ocpp_call",
      direction: "CSMS_TO_CP",
      action: "Reset",
      constraints: { payload: { type: "Hard" } },
      timeoutMs: undefined,
      nodeId: "csmsCallTrigger-1",
    });
  });

  it("omits constraints when the connectorId is undefined", () => {
    const exp = deriveExpectation(
      node(ScenarioNodeType.REMOTE_START_TRIGGER, {
        label: "Wait",
      } as ScenarioNodeData),
      undefined,
    );
    expect(exp?.constraints).toBeUndefined();
  });

  it("derives a connection expectation for connectionTrigger (#240)", () => {
    const node = {
      id: "n-conn",
      type: ScenarioNodeType.CONNECTION_TRIGGER,
      position: { x: 0, y: 0 },
      data: { label: "wait", event: "disconnected", timeout: 10 },
    } as ScenarioNode;
    expect(deriveExpectation(node, 1)).toEqual({
      type: "connection",
      event: "disconnected",
      timeoutMs: 10000,
      nodeId: "n-conn",
    });
  });

  it.each([
    ScenarioNodeType.STATUS_CHANGE,
    ScenarioNodeType.TRANSACTION,
    ScenarioNodeType.METER_VALUE,
    ScenarioNodeType.DELAY,
    ScenarioNodeType.START,
    ScenarioNodeType.END,
    ScenarioNodeType.RESPONSE_OVERRIDE,
  ])("returns null for the non-waiting node type %s", (type) => {
    expect(
      deriveExpectation(node(type, { label: "x" } as ScenarioNodeData), 1),
    ).toBeNull();
  });
});
