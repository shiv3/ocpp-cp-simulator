import { describe, expect, it } from "vitest";
import {
  meterNodeToCurveConfig,
  applyCurveConfigToMeterNode,
} from "../meterValueNodeConfig";
import { AutoMeterValueConfig } from "../../../cp/domain/connector/MeterValueCurve";

describe("meterValueNodeConfig mapping (scenario MeterValue node ↔ curve modal)", () => {
  describe("meterNodeToCurveConfig", () => {
    it("derives stopAtTargetSoc from stopMode === 'evSettings'", () => {
      expect(
        meterNodeToCurveConfig({ stopMode: "evSettings" }).stopAtTargetSoc,
      ).toBe(true);
    });

    it("leaves stopAtTargetSoc false for manual / unset stopMode", () => {
      expect(
        meterNodeToCurveConfig({ stopMode: "manual" }).stopAtTargetSoc,
      ).toBe(false);
      expect(meterNodeToCurveConfig({}).stopAtTargetSoc).toBe(false);
    });

    it("carries curve points and interval through to the modal", () => {
      const config = meterNodeToCurveConfig({
        curvePoints: [{ time: 0, value: 0 }],
        incrementInterval: 42,
        autoCalculateInterval: true,
      });
      expect(config.curvePoints).toEqual([{ time: 0, value: 0 }]);
      expect(config.intervalSeconds).toBe(42);
      expect(config.autoCalculateInterval).toBe(true);
    });
  });

  describe("applyCurveConfigToMeterNode", () => {
    it("persists 'Charge until battery full' as stopMode === 'evSettings'", () => {
      const saved: AutoMeterValueConfig = {
        enabled: true,
        curvePoints: [{ time: 0, value: 0 }],
        intervalSeconds: 10,
        autoCalculateInterval: false,
        stopAtTargetSoc: true,
      };
      const patched = applyCurveConfigToMeterNode(
        { stopMode: "manual" },
        saved,
      );
      expect(patched.stopMode).toBe("evSettings");
    });

    it("clears stopMode back to manual when the checkbox is unchecked", () => {
      const saved: AutoMeterValueConfig = {
        enabled: true,
        curvePoints: [],
        intervalSeconds: 10,
        autoCalculateInterval: false,
        stopAtTargetSoc: false,
      };
      const patched = applyCurveConfigToMeterNode(
        { stopMode: "evSettings" },
        saved,
      );
      expect(patched.stopMode).toBe("manual");
    });

    it("preserves unrelated form fields", () => {
      const saved: AutoMeterValueConfig = {
        enabled: true,
        curvePoints: [{ time: 1, value: 2 }],
        intervalSeconds: 15,
        autoCalculateInterval: true,
        stopAtTargetSoc: false,
      };
      const patched = applyCurveConfigToMeterNode(
        { label: "Meter", incrementAmount: 1000, stopMode: "manual" },
        saved,
      );
      expect(patched.label).toBe("Meter");
      expect(patched.incrementAmount).toBe(1000);
      expect(patched.curvePoints).toEqual([{ time: 1, value: 2 }]);
      expect(patched.incrementInterval).toBe(15);
    });
  });

  it("round-trips the checkbox: check → save → reopen shows it checked", () => {
    // User opens the modal on a manual node and ticks "Charge until battery full".
    const savedFromModal: AutoMeterValueConfig = {
      ...meterNodeToCurveConfig({ stopMode: "manual" }),
      stopAtTargetSoc: true,
    };
    const node = applyCurveConfigToMeterNode(
      { stopMode: "manual" },
      savedFromModal,
    );
    // Reopening the modal must reflect the persisted choice.
    expect(meterNodeToCurveConfig(node).stopAtTargetSoc).toBe(true);
  });
});
