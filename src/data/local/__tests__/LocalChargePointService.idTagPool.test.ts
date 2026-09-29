import { describe, expect, it, vi } from "vitest";

import { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import { DEFAULT_ID_TAG } from "../../../cp/domain/auth/IdTagPool";
import { DefaultBootNotification } from "../../../cp/domain/types/OcppTypes";
import { LocalChargePointService } from "../LocalChargePointService";

/**
 * #374: `ChargePointService.startTransaction` declared `tagId` required, while
 * the control plane sends none on purpose so the charge point draws from its
 * idTag pool (#299). A 2.x TransactionEvent may carry no idToken, so the tag is
 * optional there; browser mode resolves a missing one the way the daemon
 * does: pool first, then the historical default. (Authorize.req always
 * carries an idTag, so `authorize` keeps a required one.)
 */
function registeredCp(idTags: string[] = []): {
  service: LocalChargePointService;
  cp: ChargePoint;
} {
  const cp = new ChargePoint(
    "CP-POOL",
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:1/ocpp",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    { idTags },
  );
  const service = new LocalChargePointService();
  service.registerChargePoint(cp);
  return { service, cp };
}

describe("LocalChargePointService without a tagId", () => {
  it("starts the transaction with the next tag of the pool", async () => {
    const { service, cp } = registeredCp(["POOL-A", "POOL-B"]);
    const startTransaction = vi
      .spyOn(cp, "startTransaction")
      .mockResolvedValue({ started: true });

    await service.startTransaction("CP-POOL", 1);

    expect(startTransaction).toHaveBeenCalledWith(
      "POOL-A",
      1,
      undefined,
      undefined,
      {},
    );
  });

  it("starts with the default tag when the charge point has no pool", async () => {
    const { service, cp } = registeredCp();
    const startTransaction = vi
      .spyOn(cp, "startTransaction")
      .mockResolvedValue({ started: true });

    await service.startTransaction("CP-POOL", 1);

    expect(startTransaction.mock.calls[0]?.[0]).toBe(DEFAULT_ID_TAG);
  });

  it("keeps an explicit tag", async () => {
    const { service, cp } = registeredCp(["POOL-A"]);
    const startTransaction = vi
      .spyOn(cp, "startTransaction")
      .mockResolvedValue({ started: true });

    await service.startTransaction("CP-POOL", 1, "EXPLICIT");

    expect(startTransaction.mock.calls[0]?.[0]).toBe("EXPLICIT");
  });
});
