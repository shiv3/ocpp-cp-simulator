import { useEffect, useMemo, useState } from "react";

import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import {
  type EVSettings,
  defaultEVSettings,
} from "../../cp/domain/connector/EVSettings";
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
  transactionStartTime: Date | null;
  transactionTagId: string | null;
  transactionBatteryCapacityKwh: number | null;
  logs: string[];
  autoMeterValueConfig: AutoMeterValueConfig | null;
  mode: ScenarioMode;
  autoResetToAvailable: boolean;
  evSettings: EVSettings;
  chargingProfile: ActiveChargingProfile | null;
  chargingProfiles: ActiveChargingProfile[];
}

const DEFAULT_STATUS = OCPPStatus.Unavailable;
const DEFAULT_AVAILABILITY: OCPPAvailability = "Operative";
const DEFAULT_MODE: ScenarioMode = "manual";

export function useConnectorView(
  cpId: string | null,
  connectorId: number,
): ConnectorViewState {
  const { chargePointService } = useDataContext();

  const [status, setStatus] = useState<OCPPStatus>(DEFAULT_STATUS);
  const [availability, setAvailability] =
    useState<OCPPAvailability>(DEFAULT_AVAILABILITY);
  const [meterValue, setMeterValue] = useState<number>(0);
  const [soc, setSoc] = useState<number | null>(null);
  const [transactionId, setTransactionId] = useState<number | null>(null);
  const [transactionStartTime, setTransactionStartTime] = useState<Date | null>(
    null,
  );
  const [transactionTagId, setTransactionTagId] = useState<string | null>(null);
  const [transactionBatteryCapacityKwh, setTransactionBatteryCapacityKwh] =
    useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [autoMeterValueConfig, setAutoMeterValueConfig] =
    useState<AutoMeterValueConfig | null>(null);
  const [mode, setMode] = useState<ScenarioMode>(DEFAULT_MODE);
  const [autoResetToAvailable, setAutoResetToAvailable] =
    useState<boolean>(true);
  const [evSettings, setEvSettings] = useState<EVSettings>({
    ...defaultEVSettings,
  });
  const [chargingProfile, setChargingProfile] =
    useState<ActiveChargingProfile | null>(null);
  const [chargingProfiles, setChargingProfiles] = useState<
    ActiveChargingProfile[]
  >([]);

  useEffect(() => {
    if (!cpId) {
      setStatus(DEFAULT_STATUS);
      setAvailability(DEFAULT_AVAILABILITY);
      setMeterValue(0);
      setSoc(null);
      setTransactionId(null);
      setTransactionStartTime(null);
      setTransactionTagId(null);
      setTransactionBatteryCapacityKwh(null);
      setAutoMeterValueConfig(null);
      setMode(DEFAULT_MODE);
      setAutoResetToAvailable(true);
      setEvSettings({ ...defaultEVSettings });
      setChargingProfile(null);
      setChargingProfiles([]);
      setLogs([]);
      return;
    }

    let cancelled = false;

    chargePointService
      .getChargePoint(cpId)
      .then((snapshot) => {
        if (cancelled || !snapshot) return;
        const connector = snapshot.connectors.find((c) => c.id === connectorId);
        if (!connector) return;
        setStatus(connector.status);
        setAvailability(connector.availability);
        setMeterValue(connector.meterValue);
        setSoc(connector.soc);
        setTransactionId(connector.transactionId);
        setTransactionStartTime(connector.transactionStartTime);
        setTransactionTagId(connector.transactionTagId);
        setTransactionBatteryCapacityKwh(
          connector.transactionBatteryCapacityKwh,
        );
        setAutoMeterValueConfig(connector.autoMeterValueConfig);
        setMode(connector.mode);
        setAutoResetToAvailable(connector.autoResetToAvailable);
        if (connector.evSettings) setEvSettings(connector.evSettings);
        setChargingProfile(connector.chargingProfile);
        setChargingProfiles([...connector.chargingProfiles]);
      })
      .catch((err) => {
        console.error(
          `Failed to fetch connector snapshot for ${cpId}/${connectorId}`,
          err,
        );
      });

    const unsubscribe = chargePointService.subscribe(
      cpId,
      (event: ChargePointEvent) => {
        if ("connectorId" in event && event.connectorId !== connectorId) {
          return;
        }
        switch (event.type) {
          case "connector-status":
            setStatus(event.status);
            break;
          case "connector-availability":
            setAvailability(event.availability);
            break;
          case "connector-meter":
            setMeterValue(event.meterValue);
            break;
          case "connector-soc":
            setSoc(event.soc);
            break;
          case "connector-transaction":
            setTransactionId(event.transactionId);
            if (event.transactionId == null) {
              setTransactionStartTime(null);
              setTransactionTagId(null);
              setTransactionBatteryCapacityKwh(null);
            }
            break;
          case "connector-auto-meter":
            setAutoMeterValueConfig(event.config);
            break;
          case "connector-mode":
            setMode(event.mode);
            break;
          case "connector-auto-reset-to-available":
            setAutoResetToAvailable(event.enabled);
            break;
          case "connector-ev-settings":
            setEvSettings(event.settings);
            break;
          case "connector-charging-profile":
            setChargingProfile(event.profile);
            break;
          case "connector-charging-profiles":
            setChargingProfiles(event.profiles);
            break;
          case "log":
            setLogs((prev) => [
              ...prev,
              `[${event.entry.timestamp.toISOString()}] ${event.entry.message}`,
            ]);
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
  }, [cpId, connectorId, chargePointService]);

  const logsMemo = useMemo(() => [...logs], [logs]);

  return {
    status,
    availability,
    meterValue,
    soc,
    transactionId,
    transactionStartTime,
    transactionTagId,
    transactionBatteryCapacityKwh,
    logs: logsMemo,
    autoMeterValueConfig,
    mode,
    autoResetToAvailable,
    evSettings,
    chargingProfile,
    chargingProfiles,
  };
}
