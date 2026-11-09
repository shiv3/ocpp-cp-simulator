// #702, OCPP 2.0.1 B04.FR.02: a reconnect without a BootNotification reports
// the connectors whose status differs from what the CSMS last *answered*, and
// keeps what a link loss does not end (a reservation). Each case drives the
// real station against the fake CSMS with no timing on the status itself.
import { expect, test } from "bun:test";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { Rig } from "../goldenWire/rig";
import type { WireFrame } from "../goldenWire/FakeCsms";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const statusFrames = (frames: readonly WireFrame[], status: string) =>
  frames.filter(
    (f) =>
      f.dir === "CP>" &&
      f.action === "StatusNotification" &&
      (f.payload as { connectorStatus?: string; evseId?: number })
        .connectorStatus === status &&
      (f.payload as { evseId?: number }).evseId === 1,
  );

test("an availability change whose StatusNotification was lost in the drop is reported once after the reconnect", async () => {
  let muted = false;
  const rig = await Rig.create({
    version: "2.0.1",
    responders: {
      // The CSMS never answers while muted: the notification is in flight
      // when the link goes.
      StatusNotification: () => (muted ? "silent" : {}),
    },
  });
  try {
    await rig.cp.configuration.applyChange("OfflineThreshold", "3600");
    muted = true;
    rig.csms.callNoWait("ChangeAvailability", {
      operationalStatus: "Inoperative",
      evse: { id: 1 },
    });
    await wait(300);
    expect(statusFrames(rig.csms.frames, "Unavailable")).toHaveLength(1);
    const before = rig.csms.frames.length;
    rig.csms.dropConnection();
    muted = false;
    await rig.reconnected();
    await rig.csms.settle();

    const after = rig.csms.frames.slice(before);
    expect(after.filter((f) => f.action === "BootNotification")).toHaveLength(
      0,
    );
    expect(statusFrames(after, "Unavailable")).toHaveLength(1);
    expect(rig.cp.getConnector(1)?.status).toBe(OCPPStatus.Unavailable);
    expect(rig.cp.getConnector(1)?.availability).toBe("Inoperative");
  } finally {
    await rig.dispose();
  }
}, 30_000);

test("a reservation survives a link loss: still Reserved, still held, nothing re-sent", async () => {
  const rig = await Rig.create({ version: "2.0.1" });
  try {
    await rig.cp.configuration.applyChange("OfflineThreshold", "3600");
    rig.csms.callNoWait("ReserveNow", {
      id: 3,
      evseId: 1,
      expiryDateTime: FUTURE,
      idToken: { idToken: "O", type: "ISO14443" },
    });
    await rig.csms.settle();
    expect(statusFrames(rig.csms.frames, "Reserved")).toHaveLength(1);
    expect(rig.cp.reservationManager.getAllReservations()).toHaveLength(1);

    const before = rig.csms.frames.length;
    rig.csms.dropConnection();
    await rig.reconnected();
    await rig.csms.settle();

    const after = rig.csms.frames.slice(before);
    expect(
      after.filter((f) => f.dir === "CP>" && f.action === "StatusNotification"),
    ).toHaveLength(0);
    expect(rig.cp.getConnector(1)?.status).toBe(OCPPStatus.Reserved);
    expect(rig.cp.reservationManager.getAllReservations()).toHaveLength(1);
  } finally {
    await rig.dispose();
  }
}, 30_000);

test("a plug-in while offline is reported once after the reconnect", async () => {
  const rig = await Rig.create({ version: "2.0.1" });
  try {
    await rig.cp.configuration.applyChange("OfflineThreshold", "3600");
    rig.csms.dropConnection();
    await wait(50);
    rig.plugIn();
    await rig.reconnected();
    await rig.csms.settle();
    const occupied = statusFrames(rig.csms.frames, "Occupied");
    expect(occupied).toHaveLength(1);
  } finally {
    await rig.dispose();
  }
}, 30_000);
