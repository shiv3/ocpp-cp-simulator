import { describe, expect, it } from "vitest";

import { actionValidatorV16 } from "../../../../ocpp/v16/validators";
import * as validators from "../../../../ocpp/v16/validators";
import { OCPPAction } from "../OcppTypes";

const securityActions = [
  OCPPAction.SecurityEventNotification,
  OCPPAction.SignCertificate,
  OCPPAction.CertificateSigned,
  OCPPAction.DeleteCertificate,
  OCPPAction.GetInstalledCertificateIds,
  OCPPAction.InstallCertificate,
  OCPPAction.ExtendedTriggerMessage,
  OCPPAction.SignedUpdateFirmware,
  OCPPAction.SignedFirmwareStatusNotification,
  OCPPAction.LogStatusNotification,
  OCPPAction.GetLog,
] as const;

describe("OCPPAction security extension constants", () => {
  it("use exact OCPP action names and map to generated v16 validators", () => {
    for (const action of securityActions) {
      expect(action).toBe(OCPPAction[action as keyof typeof OCPPAction]);

      const exportName = `isValid${action}RequestV16`;
      const exportedValidator = validators[
        exportName as keyof typeof validators
      ] as unknown;

      expect(typeof exportedValidator).toBe("function");
      expect(actionValidatorV16[action]).toBe(exportedValidator);
    }
  });
});
