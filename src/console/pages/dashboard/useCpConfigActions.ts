import { useCallback } from "react";

import type { ChargePointConfig } from "../../../components/ChargePointConfigModal";
import type { CreateChargePointParams } from "../../../data/interfaces/ChargePointService";
import type { SimulatorConfigInput } from "../../../protocol";
import { useChargePoints } from "../../../data/hooks/useChargePoints";
import { useConfig } from "../../../data/hooks/useConfig";
import { useDataContext } from "../../../data/providers/DataProvider";
import { useGlobalTagIds } from "../../../data/hooks/useGlobalTagIds";
import { getTemplateById } from "../../../utils/scenarioTemplates";

export interface UseCpConfigActionsResult {
  addCp: (cpConfig: ChargePointConfig) => Promise<void>;
  updateCp: (cpConfig: ChargePointConfig) => Promise<void>;
  removeCp: (cpId: string) => Promise<void>;
}

/**
 * CP create/update/remove, mirroring `TopPage.tsx`'s `handleSaveChargePoint`
 * / `handleDeleteChargePoint` exactly so the console's Add/Edit/Remove
 * behave identically to the classic UI in both local and remote mode. This
 * hook is self-contained (no params) so both Dashboard (Add CP) and the CP
 * detail page (Edit CP, task 5) can call it independently — each mounts its
 * own `useConfig`/`useChargePoints` instance, same as `TopPage` does.
 */
export function useCpConfigActions(): UseCpConfigActionsResult {
  const { mode, chargePointService } = useDataContext();
  const { config, setConfig: persistConfig, isLoading } = useConfig();
  const { tagIds: tagIDs } = useGlobalTagIds();
  const { refresh } = useChargePoints(config, { isLoading });

  // Mirrors TopPage.tsx's inline `params` object (handleSaveChargePoint,
  // ~lines 171-212) — same shape is used for both create and update.
  const buildRemoteParams = useCallback(
    (cpConfig: ChargePointConfig): CreateChargePointParams => ({
      cpId: cpConfig.cpId,
      wsUrl: cpConfig.wsURL,
      ocppVersion: cpConfig.ocppVersion,
      connectors: cpConfig.connectorNumber,
      vendor: cpConfig.chargePointVendor,
      model: cpConfig.chargePointModel,
      basicAuth: cpConfig.basicAuthEnabled
        ? {
            username: cpConfig.basicAuthUsername,
            password: cpConfig.basicAuthPassword,
          }
        : null,
      soapCallbackUrl: cpConfig.soapCallbackUrl,
      soapPath: cpConfig.soapPath,
      securityProfile: cpConfig.securityProfile,
      authorizationKey: cpConfig.authorizationKey,
      cpoName: cpConfig.cpoName,
      tls: cpConfig.tls,
      tlsCaPath: cpConfig.tlsCaPath,
      tlsCertPath: cpConfig.tlsCertPath,
      tlsKeyPath: cpConfig.tlsKeyPath,
      bootNotification: {
        firmwareVersion: cpConfig.firmwareVersion,
        chargeBoxSerialNumber: cpConfig.chargeBoxSerialNumber,
        chargePointSerialNumber: cpConfig.chargePointSerialNumber,
        meterSerialNumber: cpConfig.meterSerialNumber,
        meterType: cpConfig.meterType,
        iccid: cpConfig.iccid,
        imsi: cpConfig.imsi,
      },
      autoConnect: true,
    }),
    [],
  );

  // Mirrors TopPage.tsx's post-save auto-meter-value block
  // (handleSaveChargePoint, ~lines 218-262): the Add/Edit form exposes
  // auto-meter settings that createChargePoint/updateChargePoint's request
  // body has no field for, so apply them per-connector after the CP exists.
  const applyAutoMeterValueDefaults = useCallback(
    async (cpConfig: ChargePointConfig) => {
      if (!cpConfig.autoMeterValueEnabled) return;
      const presets = await chargePointService
        .getChargePoint(cpConfig.cpId)
        .catch(() => null);
      const connectors = presets?.connectors ?? [];
      await Promise.all(
        connectors.map(async (c) => {
          const base = c.autoMeterValueConfig;
          if (!base) return;
          try {
            await chargePointService.setAutoMeterValueConfig(
              cpConfig.cpId,
              c.id,
              {
                ...base,
                enabled: true,
                intervalSeconds: cpConfig.autoMeterValueInterval,
                curvePoints: base.curvePoints?.length
                  ? base.curvePoints.map((p, i, arr) =>
                      i === arr.length - 1
                        ? { ...p, value: cpConfig.autoMeterValue }
                        : p,
                    )
                  : [
                      { time: 0, value: 0 },
                      { time: 30, value: cpConfig.autoMeterValue },
                    ],
              },
            );
          } catch (err) {
            console.warn(
              `Failed to apply auto-meter config to ${cpConfig.cpId}/${c.id}`,
              err,
            );
          }
        }),
      );
    },
    [chargePointService],
  );

  // Mirrors TopPage.tsx's remote branch of handleSaveChargePoint (~lines
  // 162-272): same create-vs-update dispatch, same auto-meter follow-up,
  // same refresh + alert-on-failure error handling (errors are reported to
  // the operator, not rethrown — the returned promise always resolves).
  const saveRemote = useCallback(
    async (cpConfig: ChargePointConfig, isEdit: boolean) => {
      try {
        const params = buildRemoteParams(cpConfig);
        if (isEdit && chargePointService.updateChargePoint) {
          await chargePointService.updateChargePoint(params);
        } else {
          await chargePointService.createChargePoint?.(params);
        }
        await applyAutoMeterValueDefaults(cpConfig);
        await refresh();
      } catch (err) {
        const action = isEdit ? "update" : "create";
        console.error(`Failed to ${action} remote CP`, err);
        alert(
          `Failed to ${action} CP: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [
      buildRemoteParams,
      chargePointService,
      applyAutoMeterValueDefaults,
      refresh,
    ],
  );

  // Mirrors TopPage.tsx's brand-new-local-CP scenario seeding (~lines
  // 320-340): pre-loads the Essential CP Behavior template on every
  // connector so the editor opens with the canonical demo flow already
  // loaded. Edits intentionally skip this.
  const seedEssentialTemplate = useCallback(
    (cpConfig: ChargePointConfig) => {
      const essential = getTemplateById("essential-cp-behavior");
      if (!essential) return;
      for (let cId = 1; cId <= cpConfig.connectorNumber; cId++) {
        const seeded = essential.createScenario(cpConfig.cpId, cId);
        void chargePointService
          .saveScenarioDefinition(cpConfig.cpId, cId, seeded)
          .catch((err) =>
            console.warn(
              `Failed to seed Essential CP Behavior for ${cpConfig.cpId}/connector ${cId}`,
              err,
            ),
          );
      }
    },
    [chargePointService],
  );

  // Mirrors TopPage.tsx's local branch of handleSaveChargePoint (~lines
  // 274-340): only `Experimental.ChargePointIDs` (cpId + connector count)
  // actually varies per CP in local mode — every other field (wsURL,
  // vendor, ocppVersion, boot notification, ...) is a single config shared
  // by all local CPs, so it's simply overwritten with the saved form's
  // values, exactly as TopPage does.
  const saveLocal = useCallback(
    async (cpConfig: ChargePointConfig, isNew: boolean) => {
      const existingIds = config?.Experimental?.ChargePointIDs ?? [];
      const nextIds = isNew
        ? [
            ...existingIds,
            {
              ChargePointID: cpConfig.cpId,
              ConnectorNumber: cpConfig.connectorNumber,
            },
          ]
        : existingIds.map((entry) =>
            entry.ChargePointID === cpConfig.cpId
              ? {
                  ChargePointID: cpConfig.cpId,
                  ConnectorNumber: cpConfig.connectorNumber,
                }
              : entry,
          );

      const newConfig: SimulatorConfigInput = {
        ...(config || {}),
        wsURL: cpConfig.wsURL,
        connectorNumber: cpConfig.connectorNumber,
        ChargePointID: cpConfig.cpId,
        tagID: tagIDs[0] || "123456",
        ocppVersion: cpConfig.ocppVersion,
        basicAuthSettings: {
          enabled: cpConfig.basicAuthEnabled,
          username: cpConfig.basicAuthUsername,
          password: cpConfig.basicAuthPassword,
        },
        autoMeterValueSetting: {
          enabled: cpConfig.autoMeterValueEnabled,
          interval: cpConfig.autoMeterValueInterval,
          value: cpConfig.autoMeterValue,
        },
        BootNotification: {
          chargePointVendor: cpConfig.chargePointVendor,
          chargePointModel: cpConfig.chargePointModel,
          firmwareVersion: cpConfig.firmwareVersion,
          chargeBoxSerialNumber: cpConfig.chargeBoxSerialNumber,
          chargePointSerialNumber: cpConfig.chargePointSerialNumber,
          meterSerialNumber: cpConfig.meterSerialNumber,
          meterType: cpConfig.meterType,
          iccid: cpConfig.iccid,
          imsi: cpConfig.imsi,
        },
        Experimental: {
          ChargePointIDs: nextIds,
          TagIDs: tagIDs,
        },
      };
      await persistConfig(newConfig);

      if (isNew) {
        seedEssentialTemplate(cpConfig);
      }
    },
    [config, tagIDs, persistConfig, seedEssentialTemplate],
  );

  const addCp = useCallback(
    async (cpConfig: ChargePointConfig) => {
      if (mode === "remote") {
        await saveRemote(cpConfig, false);
        return;
      }
      await saveLocal(cpConfig, true);
    },
    [mode, saveRemote, saveLocal],
  );

  const updateCp = useCallback(
    async (cpConfig: ChargePointConfig) => {
      if (mode === "remote") {
        await saveRemote(cpConfig, true);
        return;
      }
      await saveLocal(cpConfig, false);
    },
    [mode, saveRemote, saveLocal],
  );

  // Mirrors TopPage.tsx's handleDeleteChargePoint (~lines 343-379).
  const removeCp = useCallback(
    async (cpId: string) => {
      if (mode === "remote") {
        try {
          await chargePointService.removeChargePoint?.(cpId);
          await refresh();
        } catch (err) {
          console.error("Failed to remove remote CP", err);
          alert(
            `Failed to remove CP: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      const existingIds = config?.Experimental?.ChargePointIDs ?? [];
      const nextIds = existingIds.filter(
        (entry) => entry.ChargePointID !== cpId,
      );

      if (nextIds.length === 0) {
        await persistConfig(null);
        return;
      }

      if (!config) return;

      const newConfig: SimulatorConfigInput = {
        ...config,
        Experimental: {
          ChargePointIDs: nextIds,
          TagIDs: tagIDs.length > 0 ? tagIDs : ["123456"],
        },
      };
      await persistConfig(newConfig);
    },
    [mode, chargePointService, refresh, config, tagIDs, persistConfig],
  );

  return { addCp, updateCp, removeCp };
}
