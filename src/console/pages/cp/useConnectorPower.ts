import { useEffect, useState } from "react";

import { useDataContext } from "@/data/providers/DataProvider";
import type { ChargePointEvent } from "@/data/interfaces/ChargePointService";

/** One meter reading: when the console saw it, and the register in Wh. */
export interface PowerSample {
  t: number;
  wh: number;
}

export interface ConnectorPower {
  /** Readings of the current transaction, oldest first; empty without one. */
  samples: PowerSample[];
  /** Slope of the last two readings, in kW; 0 with fewer than two. */
  powerKw: number;
  /** The register when the transaction started (as far as the console saw
   *  it); null without a transaction. */
  startWh: number | null;
}

interface Track {
  txId: number | null;
  samples: PowerSample[];
  startWh: number | null;
}

const MAX_SAMPLES = 720;
const EMPTY: Track = { txId: null, samples: [], startWh: null };

/*
 * Per connector, outside React: the page remounts a connector's card when the
 * panel switches tabs, and the readings of a running transaction must survive
 * that. Snapshots carry no meterStart, so a transaction the console only meets
 * half-way starts from the first reading it sees.
 */
const tracks = new Map<string, Track>();

/** Forget every connector's readings (tests). */
export function clearConnectorPowerCache(): void {
  tracks.clear();
}

function powerOf(samples: PowerSample[]): number {
  if (samples.length < 2) return 0;
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const ms = b.t - a.t;
  // Wh per ms × 3600 is kW; a register set back by hand reads as 0, not < 0.
  return ms > 0 ? Math.max(0, ((b.wh - a.wh) / ms) * 3600) : 0;
}

function toPower(track: Track): ConnectorPower {
  return {
    samples: track.samples,
    powerKw: powerOf(track.samples),
    startWh: track.startWh,
  };
}

/**
 * The meter readings of a connector's current transaction, from its
 * `connector-meter` events (and the snapshot), and the power they imply: the
 * slope of the last two. A new transaction id starts the samples over.
 */
export function useConnectorPower(
  cpId: string,
  connectorId: number,
): ConnectorPower {
  const { chargePointService } = useDataContext();
  const key = `${cpId}\u0000${connectorId}`;
  const [track, setTrack] = useState<Track>(() => tracks.get(key) ?? EMPTY);

  useEffect(() => {
    let cancelled = false;
    let current = tracks.get(key) ?? EMPTY;
    let lastWh: number | null =
      current.samples[current.samples.length - 1]?.wh ?? null;
    setTrack(current);

    const commit = (next: Track) => {
      current = next;
      tracks.set(key, next);
      if (!cancelled) setTrack(next);
    };
    const record = (wh: number) => {
      lastWh = wh;
      if (current.txId == null) return;
      const samples = [...current.samples, { t: Date.now(), wh }];
      commit({ ...current, samples: samples.slice(-MAX_SAMPLES) });
    };
    const onTransaction = (txId: number | null) => {
      if (txId === current.txId) return;
      if (txId == null || lastWh == null) {
        commit({ txId, samples: [], startWh: null });
        return;
      }
      // StartTransaction's meterStart is the register at that moment.
      commit({
        txId,
        samples: [{ t: Date.now(), wh: lastWh }],
        startWh: lastWh,
      });
    };

    void chargePointService
      .getChargePoint(cpId)
      .then((snapshot) => {
        const connector = snapshot?.connectors.find(
          (c) => c.id === connectorId,
        );
        if (cancelled || !connector) return;
        if (connector.transactionId !== current.txId) {
          lastWh = connector.meterValue;
          onTransaction(connector.transactionId);
        } else if (lastWh !== connector.meterValue) {
          record(connector.meterValue);
        }
      })
      .catch(() => {
        // The card's own view reports a failed snapshot; nothing to add here.
      });

    const unsubscribe = chargePointService.subscribe(
      cpId,
      (event: ChargePointEvent) => {
        if (!("connectorId" in event) || event.connectorId !== connectorId) {
          return;
        }
        if (event.type === "connector-meter") record(event.meterValue);
        else if (event.type === "connector-transaction") {
          onTransaction(event.transactionId);
        }
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [chargePointService, cpId, connectorId, key]);

  return toPower(track);
}
