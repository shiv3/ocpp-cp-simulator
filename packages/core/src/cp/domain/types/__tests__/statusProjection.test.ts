import { describe, it, expect } from "vitest";
import {
  projectStatusForVersion,
  projectErrorCodeForVersion,
  type ProjectedChargePointStatus,
  type ProjectedChargePointErrorCode,
} from "../statusProjection";
import { OCPPStatus, type ChargePointErrorCode } from "../OcppTypes";
import {
  OCPP_1_2,
  OCPP_1_5,
  OCPP_1_6,
  OCPP_1_6_SOAP,
  OCPP_2_0_1,
  OCPP_2_1,
} from "../OcppVersion";

describe("statusProjection: projectStatusForVersion", () => {
  describe("OCPP-1.2: 4-value set (Available, Occupied, Unavailable, Faulted)", () => {
    it("projects Available → Available", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Available)).toBe(
        "Available",
      );
    });

    it("projects Faulted → Faulted", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Faulted)).toBe(
        "Faulted",
      );
    });

    it("projects Unavailable → Unavailable", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Unavailable)).toBe(
        "Unavailable",
      );
    });

    it("projects Reserved → Unavailable (no Reserved in 1.2)", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Reserved)).toBe(
        "Unavailable",
      );
    });

    it("projects Preparing → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Preparing)).toBe(
        "Occupied",
      );
    });

    it("projects Charging → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Charging)).toBe(
        "Occupied",
      );
    });

    it("projects SuspendedEV → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.SuspendedEV)).toBe(
        "Occupied",
      );
    });

    it("projects SuspendedEVSE → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.SuspendedEVSE)).toBe(
        "Occupied",
      );
    });

    it("projects Finishing → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_2, OCPPStatus.Finishing)).toBe(
        "Occupied",
      );
    });
  });

  describe("OCPP-1.5: 5-value set (Available, Occupied, Unavailable, Reserved, Faulted)", () => {
    it("projects Available → Available", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Available)).toBe(
        "Available",
      );
    });

    it("projects Faulted → Faulted", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Faulted)).toBe(
        "Faulted",
      );
    });

    it("projects Unavailable → Unavailable", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Unavailable)).toBe(
        "Unavailable",
      );
    });

    it("projects Reserved → Reserved", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Reserved)).toBe(
        "Reserved",
      );
    });

    it("projects Preparing → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Preparing)).toBe(
        "Occupied",
      );
    });

    it("projects Charging → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Charging)).toBe(
        "Occupied",
      );
    });

    it("projects SuspendedEV → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.SuspendedEV)).toBe(
        "Occupied",
      );
    });

    it("projects SuspendedEVSE → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.SuspendedEVSE)).toBe(
        "Occupied",
      );
    });

    it("projects Finishing → Occupied (transaction progress)", () => {
      expect(projectStatusForVersion(OCPP_1_5, OCPPStatus.Finishing)).toBe(
        "Occupied",
      );
    });
  });

  describe("OCPP-1.6J: 9-value passthrough (all statuses preserved)", () => {
    const versions = [OCPP_1_6, OCPP_1_6_SOAP, OCPP_2_0_1, OCPP_2_1] as const;

    for (const version of versions) {
      describe(`${version}`, () => {
        it("projects Available → Available", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Available)).toBe(
            "Available",
          );
        });

        it("projects Preparing → Preparing", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Preparing)).toBe(
            "Preparing",
          );
        });

        it("projects Charging → Charging", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Charging)).toBe(
            "Charging",
          );
        });

        it("projects SuspendedEV → SuspendedEV", () => {
          expect(projectStatusForVersion(version, OCPPStatus.SuspendedEV)).toBe(
            "SuspendedEV",
          );
        });

        it("projects SuspendedEVSE → SuspendedEVSE", () => {
          expect(
            projectStatusForVersion(version, OCPPStatus.SuspendedEVSE),
          ).toBe("SuspendedEVSE");
        });

        it("projects Finishing → Finishing", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Finishing)).toBe(
            "Finishing",
          );
        });

        it("projects Reserved → Reserved", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Reserved)).toBe(
            "Reserved",
          );
        });

        it("projects Unavailable → Unavailable", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Unavailable)).toBe(
            "Unavailable",
          );
        });

        it("projects Faulted → Faulted", () => {
          expect(projectStatusForVersion(version, OCPPStatus.Faulted)).toBe(
            "Faulted",
          );
        });
      });
    }
  });

  describe("Status matrix: all versions × all statuses", () => {
    const allStatuses = [
      OCPPStatus.Available,
      OCPPStatus.Preparing,
      OCPPStatus.Charging,
      OCPPStatus.SuspendedEV,
      OCPPStatus.SuspendedEVSE,
      OCPPStatus.Finishing,
      OCPPStatus.Reserved,
      OCPPStatus.Unavailable,
      OCPPStatus.Faulted,
    ];

    const allVersions = [OCPP_1_2, OCPP_1_5, OCPP_1_6, OCPP_1_6_SOAP] as const;

    it("all projections return valid ProjectedChargePointStatus", () => {
      const validStatuses = new Set<ProjectedChargePointStatus>([
        "Available",
        "Occupied",
        "Preparing",
        "Charging",
        "SuspendedEV",
        "SuspendedEVSE",
        "Finishing",
        "Reserved",
        "Unavailable",
        "Faulted",
      ]);

      for (const version of allVersions) {
        for (const status of allStatuses) {
          const projected = projectStatusForVersion(version, status);
          expect(validStatuses.has(projected)).toBe(true);
        }
      }
    });
  });
});

describe("statusProjection: projectErrorCodeForVersion", () => {
  describe("OCPP-1.2: 8-value set", () => {
    const directPassthrough: readonly ChargePointErrorCode[] = [
      "ConnectorLockFailure",
      "HighTemperature",
      "NoError",
      "PowerMeterFailure",
      "PowerSwitchFailure",
      "ReaderFailure",
      "ResetFailure",
    ];

    for (const code of directPassthrough) {
      it(`projects ${code} → ${code}`, () => {
        expect(projectErrorCodeForVersion(OCPP_1_2, code)).toBe(code);
      });
    }

    it("projects EVCommunicationError → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "EVCommunicationError")).toBe(
        "Mode3Error",
      );
    });

    it("projects GroundFailure → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "GroundFailure")).toBe(
        "Mode3Error",
      );
    });

    it("projects OverCurrentFailure → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "OverCurrentFailure")).toBe(
        "Mode3Error",
      );
    });

    it("projects OverVoltage → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "OverVoltage")).toBe(
        "Mode3Error",
      );
    });

    it("projects UnderVoltage → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "UnderVoltage")).toBe(
        "Mode3Error",
      );
    });

    it("projects WeakSignal → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "WeakSignal")).toBe(
        "Mode3Error",
      );
    });

    it("projects OtherError → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "OtherError")).toBe(
        "Mode3Error",
      );
    });

    it("projects InternalError → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "InternalError")).toBe(
        "Mode3Error",
      );
    });

    it("projects LocalListConflict → Mode3Error (not in 1.2)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_2, "LocalListConflict")).toBe(
        "Mode3Error",
      );
    });
  });

  describe("OCPP-1.5: 13-value set", () => {
    const directPassthrough: readonly ChargePointErrorCode[] = [
      "ConnectorLockFailure",
      "HighTemperature",
      "NoError",
      "PowerMeterFailure",
      "PowerSwitchFailure",
      "ReaderFailure",
      "ResetFailure",
      "GroundFailure",
      "OverCurrentFailure",
      "UnderVoltage",
      "WeakSignal",
      "OtherError",
    ];

    for (const code of directPassthrough) {
      it(`projects ${code} → ${code}`, () => {
        expect(projectErrorCodeForVersion(OCPP_1_5, code)).toBe(code);
      });
    }

    it("projects EVCommunicationError → Mode3Error (not in 1.5)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_5, "EVCommunicationError")).toBe(
        "Mode3Error",
      );
    });

    it("projects InternalError → OtherError (not in 1.5)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_5, "InternalError")).toBe(
        "OtherError",
      );
    });

    it("projects LocalListConflict → OtherError (not in 1.5)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_5, "LocalListConflict")).toBe(
        "OtherError",
      );
    });

    it("projects OverVoltage → OtherError (not in 1.5)", () => {
      expect(projectErrorCodeForVersion(OCPP_1_5, "OverVoltage")).toBe(
        "OtherError",
      );
    });
  });

  describe("OCPP-1.6J, 1.6S, 2.0.1, 2.1: passthrough (all 16 codes)", () => {
    const versions = [OCPP_1_6, OCPP_1_6_SOAP, OCPP_2_0_1, OCPP_2_1] as const;
    const allCodes: readonly ChargePointErrorCode[] = [
      "ConnectorLockFailure",
      "EVCommunicationError",
      "GroundFailure",
      "HighTemperature",
      "InternalError",
      "LocalListConflict",
      "NoError",
      "OtherError",
      "OverCurrentFailure",
      "OverVoltage",
      "PowerMeterFailure",
      "PowerSwitchFailure",
      "ReaderFailure",
      "ResetFailure",
      "UnderVoltage",
      "WeakSignal",
    ];

    for (const version of versions) {
      describe(`${version}`, () => {
        for (const code of allCodes) {
          it(`projects ${code} → ${code}`, () => {
            expect(projectErrorCodeForVersion(version, code)).toBe(code);
          });
        }
      });
    }
  });

  describe("ErrorCode matrix: all versions × all error codes", () => {
    const allErrorCodes: readonly ChargePointErrorCode[] = [
      "ConnectorLockFailure",
      "EVCommunicationError",
      "GroundFailure",
      "HighTemperature",
      "InternalError",
      "LocalListConflict",
      "NoError",
      "OtherError",
      "OverCurrentFailure",
      "OverVoltage",
      "PowerMeterFailure",
      "PowerSwitchFailure",
      "ReaderFailure",
      "ResetFailure",
      "UnderVoltage",
      "WeakSignal",
    ];

    const allVersions = [OCPP_1_2, OCPP_1_5, OCPP_1_6, OCPP_1_6_SOAP] as const;

    it("all projections return valid ProjectedChargePointErrorCode", () => {
      const validCodes = new Set<ProjectedChargePointErrorCode>([
        "ConnectorLockFailure",
        "EVCommunicationError",
        "GroundFailure",
        "HighTemperature",
        "InternalError",
        "LocalListConflict",
        "NoError",
        "OtherError",
        "OverCurrentFailure",
        "OverVoltage",
        "PowerMeterFailure",
        "PowerSwitchFailure",
        "ReaderFailure",
        "ResetFailure",
        "UnderVoltage",
        "WeakSignal",
        "Mode3Error",
      ]);

      for (const version of allVersions) {
        for (const code of allErrorCodes) {
          const projected = projectErrorCodeForVersion(version, code);
          expect(validCodes.has(projected)).toBe(true);
        }
      }
    });
  });
});
