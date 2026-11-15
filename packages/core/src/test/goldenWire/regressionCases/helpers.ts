// Shared helpers and the case registry of the regression golden cases. The
// group modules next to this file push into `cases` when they are imported;
// regressionCases.ts imports them in the original order.
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { resolveNetworkSimConfig } from "../../../cp/infrastructure/transport/network-sim";
import { VirtualClock } from "../../../cp/shared/clock";
import type { GoldenCase as Case } from "../cases";
import { Rig, type RigOptions } from "../rig";

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const settle = (r: Rig) => r.csms.settle();
/**
 * #867: a case whose waits are pauses on the wire (a drop that must land
 * while a latency rule holds a frame, an offline stretch, a heartbeat period)
 * runs on its own VirtualClock with the in-memory socket. `pause(ms)` moves
 * the station's clock and lets the traffic settle, so the case takes no real
 * time and a loaded machine cannot reorder it.
 */
export const virtual = (seed = "g867") => {
  const clock = new VirtualClock();
  return {
    pause: async (r: Rig, ms: number) => {
      await clock.advanceBy(ms);
      await settle(r);
    },
    options: { memory: true, simulation: { clock, seed } } as Case["options"],
  };
};
export const cases: Case[] = [];
export const c16 = (
  name: string,
  run: Case["run"],
  options?: Case["options"],
) => cases.push({ name: `16-${name}`, version: "1.6", run, options });
export const c201 = (
  name: string,
  run: Case["run"],
  options?: Case["options"],
) => cases.push({ name: `201-${name}`, version: "2.0.1", run, options });
export const c21 = (
  name: string,
  run: Case["run"],
  options?: Case["options"],
) => cases.push({ name: `21-${name}`, version: "2.1", run, options });
export const both = (
  name: string,
  run: Case["run"],
  options?: Case["options"],
) => {
  c16(name, run, options);
  c201(name, run, options);
};
export const cfg = (r: Rig, k: string, v: string) =>
  (r.cp as any).configuration.applyChange(k, v);
// Set off the wire, the way a scenario or the operator's set_config_key sets
// it (#921: the key is writable on both versions).
export const authorizeRemote = (r: Rig, on: boolean) => {
  if (cfg(r, "AuthorizeRemoteTxRequests", String(on)) !== "Accepted") {
    throw new Error("AuthorizeRemoteTxRequests cannot be set");
  }
};
export async function charging(r: Rig, tag = "TAG-1", c = 1) {
  r.plugIn(c);
  await settle(r);
  await r.cp.startTransaction(tag, c);
  await settle(r);
  r.cp.updateConnectorStatus(c, OCPPStatus.Charging);
  await settle(r);
}
// These two return the CSMS call so a case awaits the station's answer: the
// next step then never starts before the previous exchange is on the wire,
// however slow the machine (#848).
export const changeAvail = (
  r: Rig,
  type: "Operative" | "Inoperative",
  id?: number,
) =>
  r.is16
    ? r.csms.call("ChangeAvailability", { connectorId: id ?? 0, type })
    : r.csms.call("ChangeAvailability", {
        operationalStatus: type,
        ...(id === undefined ? {} : { evse: { id } }),
      });
export const reserve = (
  r: Rig,
  id: number,
  c: number,
  tag: string,
  expiry: string,
) =>
  r.is16
    ? r.csms.call("ReserveNow", {
        connectorId: c,
        expiryDate: expiry,
        idTag: tag,
        reservationId: id,
      })
    : r.csms.call("ReserveNow", {
        id,
        // 0 names no EVSE: the field is left out (H01.FR.04).
        ...(c === 0 ? {} : { evseId: c }),
        expiryDateTime: expiry,
        idToken: { idToken: tag, type: "ISO14443" },
      });
export const FUT = "2099-01-01T00:00:00.000Z";
export const two = { connectors: 2 };

// --- restart: the snapshot goes through the row format and a new station
export const roundTrip = (snap: any) => {
  const row = JSON.parse(JSON.stringify(snap));
  const tx = row.transaction;
  if (!tx) return row;
  return {
    ...row,
    transaction: {
      ...tx,
      startTime: new Date(tx.startTime),
      ...(tx.stopTime ? { stopTime: new Date(tx.stopTime) } : {}),
    },
  };
};
export async function restart(r: Rig, options: Partial<RigOptions> = {}) {
  const snaps = [...r.cp.connectors.values()].map(
    (c) => [c.id, roundTrip(c.snapshotRuntime())] as const,
  );
  const next = await Rig.create({
    version: r.version,
    noConnect: true,
    connectors: r.cp.connectors.size,
    ...options,
  });
  for (const [id, snap] of snaps)
    next.cp.getConnector(id)!.restoreRuntimeSnapshot(snap);
  await next.connectAndBoot();
  return next;
}

export const latency = (r: Rig, ms = 500) =>
  r.cp.setNetworkSimConfig(
    resolveNetworkSimConfig(
      {
        enabled: true,
        seed: 1,
        rules: { l: { type: "latency", direction: "upstream", delayMs: ms } },
      } as any,
      null,
      "CP-GOLDEN",
    ) as any,
  );
export const dropAndBack = async (r: Rig, nth = 2) => {
  r.csms.dropConnection();
  await r.reconnected(nth);
  await settle(r);
};
