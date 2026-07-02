import { useCallback, useEffect, useRef, useState } from "react";

import type { EVSettings } from "../../cp/domain/connector/EVSettings";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { ConnectorSettingsRepository } from "../../data/interfaces/ConnectorSettingsRepository";

type SocMeterSyncService = Pick<ChargePointService, "setConnectorSocMeterSync">;
type SocMeterSyncRepository = Pick<
  ConnectorSettingsRepository,
  "loadSocMeterSync" | "saveSocMeterSync"
>;

interface UseSocMeterSyncArgs {
  chargePointService: SocMeterSyncService;
  connectorSettingsRepository: SocMeterSyncRepository;
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

export function useSocMeterSync({
  chargePointService,
  connectorSettingsRepository,
  cpId,
  connectorId,
  evSettings,
}: UseSocMeterSyncArgs) {
  const [autoSyncSocMeter, setAutoSyncSocMeterState] = useState<boolean>(true);
  const touchedRef = useRef(false);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const loadSeq = ++loadSeqRef.current;

    void connectorSettingsRepository
      .loadSocMeterSync()
      .then((value) => {
        if (cancelled || touchedRef.current || loadSeq !== loadSeqRef.current) {
          return;
        }
        setAutoSyncSocMeterState(value);
      })
      .catch((err) => {
        console.warn("Failed to load SoC/Meter sync preference", err);
      });

    return () => {
      cancelled = true;
    };
  }, [connectorSettingsRepository]);

  useEffect(() => {
    void chargePointService.setConnectorSocMeterSync(
      cpId,
      connectorId,
      autoSyncSocMeter,
    );
  }, [chargePointService, cpId, connectorId, autoSyncSocMeter]);

  const setAutoSyncSocMeter = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      touchedRef.current = true;
      setAutoSyncSocMeterState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        void connectorSettingsRepository.saveSocMeterSync(resolved);
        return resolved;
      });
    },
    [connectorSettingsRepository],
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
    setAutoSyncSocMeter,
    handleToggleAutoSync,
    meterFromSoc: toMeterFromSoc,
    socFromMeter: toSocFromMeter,
  };
}
