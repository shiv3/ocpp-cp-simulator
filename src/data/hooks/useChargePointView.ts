import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ChargePointEvent,
  ChargePointSnapshot,
  ConnectorSnapshot,
} from "../interfaces/ChargePointService";
import type { LogEntry } from "../../cp/shared/Logger";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { useDataContext } from "../providers/DataProvider";

export interface HeartbeatView {
  /** Configured interval in seconds (from BootNotification.conf.interval or
   *  ChangeConfiguration HeartbeatInterval). 0 means not yet configured /
   *  disabled. */
  intervalSeconds: number;
  /** Wall-clock time of the most recent Heartbeat.req we sent, or null if
   *  none yet this session. */
  lastSentAt: Date | null;
}

interface ChargePointViewState {
  status: OCPPStatus;
  /**
   * Whether the underlying transport (WebSocket / SOAP) is up, tracked from the
   * `connected` / `disconnected` lifecycle events. This is distinct from
   * `status`: after an auto-reconnect the socket is up (`connected`) before
   * BootNotification is re-Accepted, so the OCPP `status` may still read
   * `Unavailable`. Use this for Connect/Disconnect affordances; use `status`
   * for OCPP-readiness actions (#103).
   */
  connected: boolean;
  error: string;
  connectors: Map<number, ConnectorSnapshot>;
  heartbeat: HeartbeatView;
  logs: LogEntry[];
  clearLogs: () => void;
}

const DEFAULT_STATUS = OCPPStatus.Unavailable;

function emptyConnector(id: number): ConnectorSnapshot {
  return {
    id,
    status: DEFAULT_STATUS,
    availability: "Operative",
    meterValue: 0,
    transactionId: null,
    soc: null,
    mode: "manual",
    autoResetToAvailable: true,
    autoMeterValueConfig: null,
    evSettings: null,
    chargingProfile: null,
    chargingProfiles: [],
    transactionStartTime: null,
    transactionTagId: null,
    transactionBatteryCapacityKwh: null,
  };
}

function patchConnector(
  prev: Map<number, ConnectorSnapshot>,
  connectorId: number,
  patch: Partial<ConnectorSnapshot>,
): Map<number, ConnectorSnapshot> {
  const next = new Map(prev);
  const existing = next.get(connectorId) ?? emptyConnector(connectorId);
  next.set(connectorId, { ...existing, ...patch });
  return next;
}

export function useChargePointView(cpId: string | null): ChargePointViewState {
  const { chargePointService } = useDataContext();
  const [status, setStatus] = useState<OCPPStatus>(DEFAULT_STATUS);
  const [connected, setConnected] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [connectors, setConnectors] = useState<Map<number, ConnectorSnapshot>>(
    new Map(),
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [heartbeat, setHeartbeat] = useState<HeartbeatView>({
    intervalSeconds: 0,
    lastSentAt: null,
  });

  useEffect(() => {
    if (!cpId) {
      setStatus(DEFAULT_STATUS);
      setConnected(false);
      setError("");
      setConnectors(new Map());
      setLogs([]);
      setHeartbeat({ intervalSeconds: 0, lastSentAt: null });
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const applySnapshot = (snapshot: ChargePointSnapshot | null) => {
      if (cancelled) return;
      if (!snapshot) {
        setStatus(DEFAULT_STATUS);
        setConnected(false);
        setError("");
        setConnectors(new Map());
        setHeartbeat({ intervalSeconds: 0, lastSentAt: null });
        return;
      }
      setStatus(snapshot.status);
      // No explicit transport flag in the snapshot yet; a non-Unavailable
      // status is the best proxy for "socket is up" on first load / resync.
      setConnected(snapshot.status !== DEFAULT_STATUS);
      setError(snapshot.error ?? "");
      setConnectors(
        new Map(snapshot.connectors.map((c) => [c.id, c] as const)),
      );
      if (snapshot.heartbeat) {
        setHeartbeat({
          intervalSeconds: snapshot.heartbeat.intervalSeconds,
          lastSentAt: snapshot.heartbeat.lastSentAt
            ? new Date(snapshot.heartbeat.lastSentAt)
            : null,
        });
      }
    };

    chargePointService
      .getChargePoint(cpId)
      .then(applySnapshot)
      .catch((err) => {
        console.error(`Failed to fetch snapshot for ${cpId}`, err);
      });

    unsubscribe = chargePointService.subscribe(
      cpId,
      (event: ChargePointEvent) => {
        switch (event.type) {
          case "status":
            setStatus(event.status);
            break;
          case "error":
            setError(event.error);
            break;
          case "connector-status":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, { status: event.status }),
            );
            break;
          case "connector-availability":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                availability: event.availability,
              }),
            );
            break;
          case "connector-meter":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                meterValue: event.meterValue,
              }),
            );
            break;
          case "connector-transaction":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                transactionId: event.transactionId,
              }),
            );
            break;
          case "connector-soc":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, { soc: event.soc }),
            );
            break;
          case "connector-mode":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, { mode: event.mode }),
            );
            break;
          case "connector-auto-reset-to-available":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                autoResetToAvailable: event.enabled,
              }),
            );
            break;
          case "connector-auto-meter":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                autoMeterValueConfig: event.config,
              }),
            );
            break;
          case "connector-ev-settings":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                evSettings: event.settings,
              }),
            );
            break;
          case "connector-charging-profile":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                chargingProfile: event.profile,
              }),
            );
            break;
          case "connector-charging-profiles":
            setConnectors((prev) =>
              patchConnector(prev, event.connectorId, {
                chargingProfiles: event.profiles,
              }),
            );
            break;
          case "connector-removed":
            setConnectors((prev) => {
              if (!prev.has(event.connectorId)) return prev;
              const next = new Map(prev);
              next.delete(event.connectorId);
              return next;
            });
            break;
          case "log":
            setLogs((prev) => [...prev, event.entry]);
            break;
          case "heartbeat":
            setHeartbeat({
              intervalSeconds: event.intervalSeconds,
              lastSentAt: event.lastSentAt ? new Date(event.lastSentAt) : null,
            });
            break;
          case "connected":
            // Socket is up. This fires on reconnect before BootNotification is
            // re-Accepted, so it — not `status` — is what flips the
            // Connect/Disconnect buttons back (#103).
            setConnected(true);
            break;
          case "disconnected":
            setConnected(false);
            break;
          default:
            break;
        }
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [cpId, chargePointService]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const connectorsMemo = useMemo(() => new Map(connectors), [connectors]);

  return {
    status,
    connected,
    error,
    connectors: connectorsMemo,
    heartbeat,
    logs,
    clearLogs,
  };
}
