import { describe, expect, it } from "vitest";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import {
  ScenarioNodeType,
  type ScenarioNodeData,
} from "../../../cp/application/scenario/ScenarioTypes";
import {
  NODE_FORM_REGISTRY,
  meterValueFormToNodeData,
  meterValueNodeDataToForm,
} from "../forms/nodeFormRegistry";
import type { NodeFormData } from "../forms/types";

function expectFormRoundTrip(type: ScenarioNodeType, formData: NodeFormData) {
  const entry = NODE_FORM_REGISTRY[type];
  const saved = entry.formToNodeData(formData);
  expect(entry.nodeDataToForm(saved)).toEqual(formData);
}

function expectUnknownFieldsDropped(
  type: ScenarioNodeType,
  nodeData: ScenarioNodeData,
) {
  const entry = NODE_FORM_REGISTRY[type];
  const saved = entry.formToNodeData(
    entry.nodeDataToForm({
      ...nodeData,
      progress: { remaining: 1, total: 2 },
      currentValue: 12345,
      runtimeOnly: "drop me",
    } as unknown as ScenarioNodeData),
  );

  expect(saved).not.toHaveProperty("progress");
  expect(saved).not.toHaveProperty("currentValue");
  expect(saved).not.toHaveProperty("runtimeOnly");
}

describe("NODE_FORM_REGISTRY", () => {
  it("has an entry for every ScenarioNodeType", () => {
    expect(Object.keys(NODE_FORM_REGISTRY).sort()).toEqual(
      Object.values(ScenarioNodeType).sort(),
    );
  });

  it("round-trips every MeterValue form field and drops runtime fields", () => {
    const formData: NodeFormData = {
      label: "Meter",
      description: "all meter fields",
      value: 2500,
      sendMessage: true,
      autoIncrement: true,
      outputKw: 44,
      maxChargeKwh: 18,
      incrementInterval: 5,
      incrementAmount: 61.11,
      stopMode: "evSettings",
      maxTime: 120,
      maxValue: 18000,
      useCurve: true,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 30, value: 5000 },
      ],
      autoCalculateInterval: false,
    };

    expect(
      meterValueNodeDataToForm(meterValueFormToNodeData(formData)),
    ).toEqual(formData);
    expectUnknownFieldsDropped(
      ScenarioNodeType.METER_VALUE,
      meterValueFormToNodeData(formData),
    );
  });

  it("round-trips hidden Transaction fields and drops runtime fields", () => {
    const formData: NodeFormData = {
      label: "Start Tx",
      description: "with hidden EV metadata",
      action: "start",
      tagId: "TAG-123",
      batteryCapacityKwh: 77.7,
      initialSoc: 23.5,
    };

    expectFormRoundTrip(ScenarioNodeType.TRANSACTION, formData);
    expectUnknownFieldsDropped(
      ScenarioNodeType.TRANSACTION,
      NODE_FORM_REGISTRY[ScenarioNodeType.TRANSACTION].formToNodeData(formData),
    );
  });

  it("round-trips form-less DataTransfer fields and drops runtime fields", () => {
    const formData: NodeFormData = {
      label: "Vendor ping",
      description: "form-less node still preserves known config",
      vendorId: "com.example",
      messageId: "diag",
      data: '{"hello":true}',
    };

    expectFormRoundTrip(ScenarioNodeType.DATA_TRANSFER, formData);
    expectUnknownFieldsDropped(
      ScenarioNodeType.DATA_TRANSFER,
      NODE_FORM_REGISTRY[ScenarioNodeType.DATA_TRANSFER].formToNodeData(
        formData,
      ),
    );
  });

  it("round-trips form-less StatusNotification fields and drops runtime fields", () => {
    const formData: NodeFormData = {
      label: "Fault with vendor code",
      description: "currently no extra UI",
      status: OCPPStatus.Faulted,
      errorCode: "GroundFailure",
      info: "relay opened",
      vendorErrorCode: "GF-7",
      vendorId: "acme",
      connectorId: 2,
    };

    expectFormRoundTrip(ScenarioNodeType.STATUS_NOTIFICATION, formData);
    expectUnknownFieldsDropped(
      ScenarioNodeType.STATUS_NOTIFICATION,
      NODE_FORM_REGISTRY[ScenarioNodeType.STATUS_NOTIFICATION].formToNodeData(
        formData,
      ),
    );
  });
});
