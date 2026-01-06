import { useEffect, useState } from "react";

import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { Config } from "../../store/store";
import { DefaultBootNotification } from "../../cp/domain/types/OcppTypes";
import { useDataContext } from "../providers/DataProvider";
import { LocalChargePointService, type LocalChargePointDefinition } from "../local/LocalChargePointService";

interface UseChargePointsOptions {
  isLoading?: boolean;
}

export function useChargePoints(
  config: Config | null,
  { isLoading = false }: UseChargePointsOptions = {},
): ChargePoint[] {
  const { chargePointService } = useDataContext();
  const [chargePoints, setChargePoints] = useState<ChargePoint[]>([]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const isLocalService = chargePointService instanceof LocalChargePointService;

    if (!config || !config.Experimental || config.Experimental.ChargePointIDs.length === 0) {
      if (isLocalService) {
        void chargePointService.syncLocalChargePoints([]);
      }
      setChargePoints([]);
      return;
    }

    if (isLocalService) {
      const definitions: LocalChargePointDefinition[] = config.Experimental.ChargePointIDs.map((cp) => ({
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
        .then((items) => setChargePoints(items))
        .catch((error) => {
          console.error("Failed to sync local charge points", error);
          setChargePoints([]);
        });
      return;
    }

    // TODO: fetch charge points via GraphQL once remote adapters are implemented
    setChargePoints([]);
  }, [chargePointService, config, isLoading]);

  return chargePoints;
}
