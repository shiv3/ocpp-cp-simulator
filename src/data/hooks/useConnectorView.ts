import { useEffect, useMemo, useState } from "react";

import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ScenarioMode } from "../../cp/application/scenario/ScenarioTypes";
import { OCPPAvailability, OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { ChargePointEvent } from "../interfaces/ChargePointService";
import { useDataContext } from "../providers/DataProvider";

interface ConnectorViewState {
  status: OCPPStatus;
  availability: OCPPAvailability;
  meterValue: number;
  soc: number | null;
  transactionId: number | null;
  logs: string[];
  autoMeterValueConfig: AutoMeterValueConfig | null;
  mode: ScenarioMode;
}

const DEFAULT_STATUS = OCPPStatus.Unavailable;
const DEFAULT_AVAILABILITY: OCPPAvailability = "Operative";
const DEFAULT_MODE: ScenarioMode = "manual";

export function useConnectorView(chargePoint: ChargePoint | null, connectorId: number): ConnectorViewState {
  const { chargePointService } = useDataContext();
  const chargePointId = chargePoint?.id ?? null;
  const initialConnector = chargePoint?.getConnector(connectorId) ?? null;

  const [status, setStatus] = useState<OCPPStatus>(initialConnector?.status as OCPPStatus ?? DEFAULT_STATUS);
  const [availability, setAvailability] = useState<OCPPAvailability>(initialConnector?.availability ?? DEFAULT_AVAILABILITY);
  const [meterValue, setMeterValue] = useState<number>(initialConnector?.meterValue ?? 0);
  const [soc, setSoc] = useState<number | null>(initialConnector?.soc ?? null);
  const [transactionId, setTransactionId] = useState<number | null>(initialConnector?.transaction?.id ?? null);
  const [logs, setLogs] = useState<string[]>([]);
  const [autoMeterValueConfig, setAutoMeterValueConfig] = useState<AutoMeterValueConfig | null>(
    initialConnector?.autoMeterValueConfig ?? null,
  );
  const [mode, setMode] = useState<ScenarioMode>(initialConnector?.mode ?? DEFAULT_MODE);

  useEffect(() => {
    if (!chargePointId) {
      setStatus(DEFAULT_STATUS);
      setAvailability(DEFAULT_AVAILABILITY);
      setMeterValue(0);
      setSoc(null);
      setTransactionId(null);
      setAutoMeterValueConfig(null);
      setMode(DEFAULT_MODE);
      setLogs([]);
      return;
    }

    const connector = chargePoint?.getConnector(connectorId);
    if (connector) {
      setStatus(connector.status as OCPPStatus);
      setAvailability(connector.availability);
      setMeterValue(connector.meterValue);
      setSoc(connector.soc);
      setTransactionId(connector.transaction?.id ?? null);
      setAutoMeterValueConfig(connector.autoMeterValueConfig ?? null);
      setMode(connector.mode);
    }

    const unsubscribe = chargePointService.subscribe(chargePointId, (event: ChargePointEvent) => {
      switch (event.type) {
        case "connector-status":
          if (event.connectorId === connectorId) {
            setStatus(event.status);
          }
          break;
        case "connector-availability":
          if (event.connectorId === connectorId) {
            setAvailability(event.availability);
          }
          break;
        case "connector-meter":
          if (event.connectorId === connectorId) {
            setMeterValue(event.meterValue);
          }
          break;
        case "connector-soc":
          if (event.connectorId === connectorId) {
            setSoc(event.soc);
          }
          break;
        case "connector-transaction":
          if (event.connectorId === connectorId) {
            setTransactionId(event.transactionId);
          }
          break;
        case "connector-auto-meter":
          if (event.connectorId === connectorId) {
            setAutoMeterValueConfig(event.config);
          }
          break;
        case "connector-mode":
          if (event.connectorId === connectorId) {
            setMode(event.mode);
          }
          break;
        case "log":
          setLogs((prev) => [...prev, `[${event.entry.timestamp.toISOString()}] ${event.entry.message}`]);
          break;
        default:
          break;
      }
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [chargePoint, chargePointId, connectorId, chargePointService]);

  const logsMemo = useMemo(() => [...logs], [logs]);

  return {
    status,
    availability,
    meterValue,
    soc,
    transactionId,
    logs: logsMemo,
    autoMeterValueConfig,
    mode,
  };
}
