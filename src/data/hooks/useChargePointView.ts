import { useCallback, useEffect, useMemo, useState } from "react";

import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { ConnectorSnapshot, ChargePointSnapshot, ChargePointEvent } from "../interfaces/ChargePointService";
import type { LogEntry } from "../../cp/shared/Logger";
import { useDataContext } from "../providers/DataProvider";

interface ChargePointViewState {
  status: ChargePointSnapshot["status"];
  error: string;
  connectors: Map<number, ConnectorSnapshot>;
  logs: LogEntry[];
  clearLogs: () => void;
}

const DEFAULT_STATUS = "Unavailable" as ChargePointSnapshot["status"];

export function useChargePointView(chargePoint: ChargePoint | null): ChargePointViewState {
  const { chargePointService } = useDataContext();
  const chargePointId = chargePoint?.id ?? null;
  const [status, setStatus] = useState<ChargePointSnapshot["status"]>(chargePoint?.status ?? DEFAULT_STATUS);
  const [error, setError] = useState<string>(chargePoint?.error ?? "");
  const [connectors, setConnectors] = useState<Map<number, ConnectorSnapshot>>(() => {
    if (!chargePoint) return new Map();
    const entries: [number, ConnectorSnapshot][] = Array.from(chargePoint.connectors.values()).map((connector) => [
      connector.id,
      {
        id: connector.id,
        status: connector.status as ConnectorSnapshot["status"],
        availability: connector.availability,
        meterValue: connector.meterValue,
        transactionId: connector.transaction?.id ?? null,
      },
    ]);
    return new Map(entries);
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!chargePointId) {
      setStatus(DEFAULT_STATUS);
      setError("");
      setConnectors(new Map());
      setLogs([]);
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    const applySnapshot = (snapshot: ChargePointSnapshot | null) => {
      if (!snapshot) {
        setStatus(DEFAULT_STATUS);
        setError("");
        setConnectors(new Map());
        return;
      }

      setStatus(snapshot.status);
      setError(snapshot.error ?? "");
      setConnectors(new Map(snapshot.connectors.map((connector) => [connector.id, connector])));
    };

    chargePointService
      .getChargePoint(chargePointId)
      .then((snapshot) => {
        if (!cancelled) {
          applySnapshot(snapshot);
        }
      })
      .catch((err) => {
        console.error(`Failed to fetch charge point snapshot for ${chargePointId}`, err);
      });

    unsubscribe = chargePointService.subscribe(chargePointId, (event: ChargePointEvent) => {
      switch (event.type) {
        case "status":
          setStatus(event.status);
          break;
        case "error":
          setError(event.error);
          break;
        case "connector-status":
          setConnectors((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.connectorId);
            next.set(event.connectorId, {
              id: event.connectorId,
              status: event.status,
              availability: existing?.availability ?? "Operative",
              meterValue: existing?.meterValue ?? 0,
              transactionId: existing?.transactionId ?? null,
            });
            return next;
          });
          break;
        case "connector-availability":
          setConnectors((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.connectorId);
            next.set(event.connectorId, {
              id: event.connectorId,
              status: existing?.status ?? DEFAULT_STATUS,
              availability: event.availability,
              meterValue: existing?.meterValue ?? 0,
              transactionId: existing?.transactionId ?? null,
            });
            return next;
          });
          break;
        case "connector-meter":
          setConnectors((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.connectorId);
            next.set(event.connectorId, {
              id: event.connectorId,
              status: existing?.status ?? DEFAULT_STATUS,
              availability: existing?.availability ?? "Operative",
              meterValue: event.meterValue,
              transactionId: existing?.transactionId ?? null,
            });
            return next;
          });
          break;
        case "connector-transaction":
          setConnectors((prev) => {
            const next = new Map(prev);
            const existing = next.get(event.connectorId);
            next.set(event.connectorId, {
              id: event.connectorId,
              status: existing?.status ?? DEFAULT_STATUS,
              availability: existing?.availability ?? "Operative",
              meterValue: existing?.meterValue ?? 0,
              transactionId: event.transactionId,
            });
            return next;
          });
          break;
        case "log":
          setLogs((prev) => [...prev, event.entry]);
          break;
        default:
          break;
      }
    });

    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [chargePointId, chargePointService]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    if (chargePoint) {
      chargePoint.logger.clearLogs();
    }
  }, [chargePoint]);

  // keep connectors map in sync when hook receives a new chargePoint instance (local mode)
  useEffect(() => {
    if (!chargePoint) {
      return;
    }

    setStatus(chargePoint.status);
    setError(chargePoint.error);
    setConnectors(() => {
      const entries: [number, ConnectorSnapshot][] = Array.from(chargePoint.connectors.values()).map((connector) => [
        connector.id,
        {
          id: connector.id,
          status: connector.status as ConnectorSnapshot["status"],
          availability: connector.availability,
          meterValue: connector.meterValue,
          transactionId: connector.transaction?.id ?? null,
        },
      ]);
      return new Map(entries);
    });
  }, [chargePoint]);

  const connectorsMemo = useMemo(() => new Map(connectors), [connectors]);

  return {
    status,
    error,
    connectors: connectorsMemo,
    logs,
    clearLogs,
  };
}
