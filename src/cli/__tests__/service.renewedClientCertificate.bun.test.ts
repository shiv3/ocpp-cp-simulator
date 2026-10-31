import { describe, expect, it, spyOn } from "bun:test";

import { CLIChargePointService } from "../service";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import {
  leafForCsr,
  selfSignedRoot,
} from "../../cp/domain/security/__tests__/certificateFixtures";
import { testCpInit } from "./testCpInit";

/**
 * #537: `CPRegistry.update` (cp.update) cleans the service up with
 * `permanent = false`, then replaces it. A manual disconnect keeps the
 * renewed certificate wait, so this cleanup must end it itself: the
 * discarded instance keeps no timer, no store listener and no key.
 */
describe("CLIChargePointService.cleanup() and the renewed client certificate", () => {
  it("releases the wait and the keys of the instance it discards", async () => {
    const svc = new CLIChargePointService(
      testCpInit({
        cpId: "cp-537-update",
        wsUrl: "wss://127.0.0.1:65534/never",
        ocppVersion: "OCPP-2.0.1",
        securityProfile: 3,
        tls: { cert: "CONFIGURED CERT", key: "CONFIGURED KEY" },
      }),
      null,
    );
    const cp = (svc as unknown as { _chargePoint: ChargePoint })._chargePoint;
    const store = cp.certificateStore;
    const root = await selfSignedRoot("01", "Root");
    const csr = await store.generateNewCsr(cp.id, "CPO");
    await store.applySignedChain("ChargingStationCertificate", [
      await leafForCsr("02", csr, root),
    ]);
    const identity = await store.tlsClientIdentity();
    expect(identity).toBeDefined();
    const read = spyOn(store, "tlsClientIdentity").mockResolvedValue({
      ...identity!,
      notBefore: new Date(Date.now() + 60_000),
    });
    await cp.useRenewedClientCertificate();
    const timer = () =>
      (cp as unknown as { _clientCertificateSwitchTimer: unknown })
        ._clientCertificateSwitchTimer;
    expect(timer()).not.toBeNull();

    svc.cleanup();

    expect(timer()).toBeNull();
    read.mockRestore();
    expect(await store.tlsClientIdentity()).toBeUndefined();
    expect(store.listSignedChains("ChargingStationCertificate")).toHaveLength(
      1,
    );
    // The store listener is detached: a change no longer reads the key.
    const after = spyOn(store, "hasTlsClientIdentity");
    store.clearAll();
    await Bun.sleep(10);
    expect(after).not.toHaveBeenCalled();
  });
});
