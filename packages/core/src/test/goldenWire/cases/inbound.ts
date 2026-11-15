import type { GoldenCase } from "./helpers";
import { both, c16, c201, settle } from "./helpers";

export const inboundCases: GoldenCase[] = [
  // --- inbound policy and response override ----------------------------
  ...both("inbound-policy-callerror", async (rig) => {
    rig.cp.setInboundCallPolicy("UnlockConnector", {
      kind: "callerror",
      errorCode: "NotSupported",
      errorDescription: "policy says no",
    });
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
    rig.cp.clearInboundCallPolicy("UnlockConnector");
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("inbound-policy-ignore", async (rig) => {
    rig.cp.setInboundCallPolicy("TriggerMessage", { kind: "ignore" });
    rig.csms.callNoWait(
      "TriggerMessage",
      rig.is16
        ? { requestedMessage: "Heartbeat" }
        : { requestedMessage: "Heartbeat" },
    );
    await settle(rig);
  }),
  ...both("response-override", async (rig) => {
    rig.cp.armResponseOverride("UnlockConnector", "Failed");
    const payload = rig.is16
      ? { connectorId: 1 }
      : { evseId: 1, connectorId: 1 };
    await rig.csms.call("UnlockConnector", payload);
    await settle(rig);
    // one-shot: the second call is answered by the real handler
    await rig.csms.call("UnlockConnector", payload);
    await settle(rig);
  }),
  c16("response-override-remote-start-rejected", async (rig) => {
    rig.cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    await rig.csms.call("RemoteStartTransaction", {
      idTag: "TAG-X",
      connectorId: 1,
    });
    await settle(rig);
  }),
  c201("response-override-alias", async (rig) => {
    // armed under the 1.6 spelling, consumed by the 2.x call
    rig.cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    await rig.csms.call("RequestStartTransaction", {
      idToken: { idToken: "TAG-X", type: "ISO14443" },
      remoteStartId: 2,
      evseId: 1,
    });
    await settle(rig);
  }),
  ...both("unknown-action", async (rig) => {
    await rig.csms.call("NoSuchAction", {});
    await settle(rig);
  }),
  c201("malformed-payload", async (rig) => {
    await rig.csms.call("UnlockConnector", { evseId: "one" });
    await settle(rig);
  }),
];
