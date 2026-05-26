import { useCallback, useEffect, useState } from "react";

import type { Config } from "../../store/store";
import { DefaultBootNotification } from "../../cp/domain/types/OcppTypes";
import { useDataContext } from "../providers/DataProvider";
import {
  LocalChargePointService,
  type LocalChargePointDefinition,
} from "../local/LocalChargePointService";
import type { ChargePointSnapshot } from "../interfaces/ChargePointService";

interface UseChargePointsOptions {
  isLoading?: boolean;
}

interface UseChargePointsResult {
  chargePoints: ChargePointSnapshot[];
  refresh: () => Promise<void>;
}

const REMOTE_POLL_INTERVAL_MS = 4000;

/**
 * Returns the active list of ChargePointSnapshot in the current mode.
 * - Local: syncs LocalChargePointService against config and lists snapshots.
 * - Remote: lists CPs from the connected server, with periodic polling.
 */
export function useChargePoints(
  config: Config | null,
  { isLoading = false }: UseChargePointsOptions = {},
): UseChargePointsResult {
  const { chargePointService, mode } = useDataContext();
  const [chargePoints, setChargePoints] = useState<ChargePointSnapshot[]>([]);

  // Manual refresh exposed to callers. Has no per-effect cancellation —
  // intended for explicit user-driven refetches (e.g. after Add CP).
  const refresh = useCallback(async () => {
    try {
      const list = await chargePointService.listChargePoints();
      setChargePoints(list);
    } catch (err) {
      console.error("Failed to list charge points", err);
      setChargePoints([]);
    }
  }, [chargePointService]);

  useEffect(() => {
    // Per-effect cancellation: each run owns its own flag so a request in
    // flight when the service / mode / config changes can't overwrite the
    // new effect's state.
    let cancelled = false;
    if (isLoading) return;

    const setIfActive = (list: ChargePointSnapshot[]) => {
      if (!cancelled) setChargePoints(list);
    };

    if (mode === "local") {
      const isLocalService =
        chargePointService instanceof LocalChargePointService;

      if (
        !isLocalService ||
        !config ||
        !config.Experimental ||
        config.Experimental.ChargePointIDs.length === 0
      ) {
        if (isLocalService) {
          void chargePointService.syncLocalChargePoints([]);
        }
        setIfActive([]);
        return () => {
          cancelled = true;
        };
      }

      const definitions: LocalChargePointDefinition[] =
        config.Experimental.ChargePointIDs.map((cp) => ({
          id: cp.ChargePointID,
          connectorNumber: cp.ConnectorNumber,
          bootNotification: config.BootNotification ?? DefaultBootNotification,
          wsUrl: config.wsURL,
          basicAuth: config.basicAuthSettings?.enabled
            ? {
                username: config.basicAuthSettings.username,
                password: config.basicAuthSettings.password,
              }
            : null,
          autoMeterValueSetting: config.autoMeterValueSetting ?? null,
        }));

      chargePointService
        .syncLocalChargePoints(definitions)
        .then(async () => {
          // Preserve the config-defined order. listChargePoints() returns
          // Map insertion order, which can desync from chargePointConfigs
          // when an id is renamed.
          const snapshots = await Promise.all(
            definitions.map((d) =>
              chargePointService.getChargePoint(d.id).catch(() => null),
            ),
          );
          setIfActive(
            snapshots.filter((s): s is ChargePointSnapshot => s !== null),
          );
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("Failed to sync local charge points", err);
          setIfActive([]);
        });
      return () => {
        cancelled = true;
      };
    }

    // Remote mode: poll the list periodically.
    const fetchOnce = async () => {
      try {
        const list = await chargePointService.listChargePoints();
        setIfActive(list);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to list charge points", err);
        setIfActive([]);
      }
    };
    void fetchOnce();
    const interval = setInterval(fetchOnce, REMOTE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chargePointService, mode, config, isLoading]);

  return { chargePoints, refresh };
}
