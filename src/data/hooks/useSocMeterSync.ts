import { useCallback, useEffect, useRef, useState } from "react";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { ChargePointService } from "../interfaces/ChargePointService";

type SocMeterSyncService = Pick<
  ChargePointService,
  "getSocMeterSync" | "saveSocMeterSync" | "setConnectorSocMeterSync"
>;

interface UseSocMeterSyncArgs {
  chargePointService: SocMeterSyncService;
  cpId: string;
  connectorId: number;
  evSettings: EVSettings;
}

const clampSoc = (soc: number): number => {
  if (!Number.isFinite(soc)) return 0;
  return Math.min(100, Math.max(0, soc));
};

export function meterFromSoc(soc: number, evSettings: EVSettings): number {
  const capacityKwh = evSettings.batteryCapacityKwh;
  if (capacityKwh <= 0) return 0;
  const initialSoc = evSettings.initialSoc ?? 0;
  return Math.max(
    0,
    Math.round(((clampSoc(soc) - initialSoc) / 100) * capacityKwh * 1000),
  );
}

export function socFromMeter(meterWh: number, evSettings: EVSettings): number {
  const capacityKwh = evSettings.batteryCapacityKwh;
  if (capacityKwh <= 0) return 0;
  const boundedMeterWh = Number.isFinite(meterWh) ? Math.max(0, meterWh) : 0;
  const initialSoc = evSettings.initialSoc ?? 0;
  const computed = initialSoc + (boundedMeterWh / 1000 / capacityKwh) * 100;
  return clampSoc(computed);
}

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function useSocMeterSync({
  chargePointService,
  cpId,
  connectorId,
  evSettings,
}: UseSocMeterSyncArgs) {
  const [autoSyncSocMeter, setAutoSyncSocMeterState] = useState<boolean>(true);
  // Whether `autoSyncSocMeter` is known: the saved preference has loaded, or
  // the operator has toggled it. Until then nothing is pushed — pushing the
  // initial `true` to a connector that is off would make it derive its SoC
  // from the meter, overwriting a hand-set SoC (`Connector.socMeterSyncEnabled`).
  const [isKnown, setIsKnown] = useState(false);
  // Why the preference could not be read, saved or applied, for the
  // operator: until it is known, `autoSyncSocMeter` is only a default.
  const [error, setError] = useState<string | null>(null);
  const touchedRef = useRef(false);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const loadSeq = ++loadSeqRef.current;
    setIsKnown(touchedRef.current);

    void chargePointService
      .getSocMeterSync(cpId, connectorId)
      .then((value) => {
        if (cancelled || touchedRef.current || loadSeq !== loadSeqRef.current) {
          return;
        }
        setAutoSyncSocMeterState(value);
        setIsKnown(true);
      })
      .catch((err) => {
        console.warn("Failed to load SoC/Meter sync preference", err);
        if (cancelled || touchedRef.current || loadSeq !== loadSeqRef.current) {
          return;
        }
        setError(
          `Sync preference not read (${describeError(err)}): Set SoC leaves the meter alone until you turn sync on.`,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [chargePointService, cpId, connectorId]);

  useEffect(() => {
    if (!isKnown) return;
    chargePointService
      .setConnectorSocMeterSync(cpId, connectorId, autoSyncSocMeter)
      .catch((err) => {
        console.error("Failed to apply SoC/Meter sync to the connector", err);
        setError(`Sync not applied to the connector: ${describeError(err)}`);
      });
  }, [chargePointService, cpId, connectorId, autoSyncSocMeter, isKnown]);

  const setAutoSyncSocMeter = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      touchedRef.current = true;
      setIsKnown(true);
      setError(null);
      setAutoSyncSocMeterState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        chargePointService
          .saveSocMeterSync(cpId, connectorId, resolved)
          .catch((err) => {
            console.error("Failed to save SoC/Meter sync preference", err);
            setError(
              `Sync turned ${resolved ? "on" : "off"}, but not saved: ${describeError(err)}`,
            );
          });
        return resolved;
      });
    },
    [chargePointService, cpId, connectorId],
  );

  const handleToggleAutoSync = useCallback(() => {
    setAutoSyncSocMeter((prev) => !prev);
  }, [setAutoSyncSocMeter]);

  const toMeterFromSoc = useCallback(
    (soc: number) => meterFromSoc(soc, evSettings),
    [evSettings],
  );
  const toSocFromMeter = useCallback(
    (meterWh: number) => socFromMeter(meterWh, evSettings),
    [evSettings],
  );

  return {
    autoSyncSocMeter,
    isKnown,
    error,
    setAutoSyncSocMeter,
    handleToggleAutoSync,
    meterFromSoc: toMeterFromSoc,
    socFromMeter: toSocFromMeter,
  };
}
