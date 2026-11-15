import type { GoldenCase } from "./helpers";
import { both, c201, charging, settle } from "./helpers";

export const connectionLossCases: GoldenCase[] = [
  // --- connection loss ---------------------------------------------------
  ...both("csms-drops-connection", async (rig) => {
    rig.csms.dropConnection();
    await rig.reconnected();
    await settle(rig);
  }),
  ...both("cp-disconnect-connect", async (rig) => {
    rig.cp.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    await rig.connectAndBoot();
  }),
  ...both("transaction-stopped-while-offline", async (rig) => {
    await charging(rig);
    rig.cp.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    rig.cp.stopTransaction(1);
    await new Promise((r) => setTimeout(r, 100));
    await rig.connectAndBoot();
    await settle(rig);
  }),
  ...both("csms-silent-then-reconnect", async (rig) => {
    rig.cp.setInboundCallPolicy("DataTransfer", { kind: "ignore" });
    rig.csms.callNoWait("DataTransfer", { vendorId: "com.example" });
    await settle(rig);
    rig.csms.dropConnection();
    await rig.reconnected();
    await settle(rig);
  }),
  // #697: TxStartPoint / TxStopPoint drive the TransactionEvent timing. The
  // defaults (Authorized / Authorized,EVConnected) are every other 201 case.
  // EVConnected start: Started at the plug-in, the tag is an Updated event.
  c201("tx-start-ev-connected-local", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    await rig.startLocal("TAG-1");
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  c201("tx-start-ev-connected-remote", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    await settle(rig);
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    await rig.remoteStart();
    await rig.remoteStop();
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // Review of #960: EVConnected alone does not start at the authorization. A
  // tag before the plug-in is authorized and waits; the plug-in starts the
  // transaction (Started CablePluggedIn) and the token follows as Updated.
  c201("tx-start-ev-connected-tag-before-plugin", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    await settle(rig);
    await rig.startLocal("TAG-1");
    await settle(rig);
    rig.cp.evPlugIn(1);
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  c201("tx-start-ev-connected-remote-before-plugin", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "EVConnected");
    await settle(rig);
    await rig.remoteStart();
    await settle(rig);
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    await settle(rig);
    await rig.remoteStop();
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // The earlier of the two starts: here the plug-in.
  c201("tx-start-authorized-or-ev-connected", async (rig) => {
    rig.cp.configuration.applyChange("TxStartPoint", "Authorized,EVConnected");
    rig.cp.evPlugIn(1);
    await rig.csms.waitForCall("TransactionEvent");
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // A cable that leaves before any tag ends the transaction it started.
  // F03.FR.02 / C15.FR.03: without Authorized in TxStopPoint a remote stop
  // is an Updated event and the unplug ends the transaction.
  c201("tx-stop-ev-connected-remote-stop", async (rig) => {
    rig.cp.configuration.applyChange("TxStopPoint", "EVConnected");
    rig.cp.evPlugIn(1);
    await settle(rig);
    await rig.startLocal("TAG-1");
    await rig.remoteStop();
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // Review of #960: a stop that is not an authorization ending (a reason such
  // as EVDisconnected, no trigger reason) ends the transaction (Ended).
  c201("tx-stop-ev-connected-behavior-stop", async (rig) => {
    rig.cp.configuration.applyChange("TxStopPoint", "EVConnected");
    rig.cp.evPlugIn(1);
    await settle(rig);
    await rig.startLocal("TAG-1");
    await settle(rig);
    rig.cp.stopTransaction(1, "EVDisconnected");
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  // C15.FR.03: a deauthorization with TxStopPoint EVConnected is an Updated
  // event (triggerReason Deauthorized); the unplug ends the transaction.
  c201("tx-stop-ev-connected-deauthorized", async (rig) => {
    rig.cp.configuration.applyChange("TxStopPoint", "EVConnected");
    rig.csms.responders["TransactionEvent"] = (p: { eventType?: string }) =>
      p.eventType === "Started" ? { idTokenInfo: { status: "Invalid" } } : {};
    rig.plugIn();
    await settle(rig);
    await rig.cp.startTransaction("TAG-A", 1);
    await settle(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
];
