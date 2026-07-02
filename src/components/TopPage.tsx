import React, { useCallback, useEffect, useState, useMemo } from "react";
import ChargePoint from "./ChargePoint.tsx";
import ChargePointConfigModal, {
  ChargePointConfig,
  defaultChargePointConfig,
} from "./ChargePointConfigModal.tsx";
import { Plus, Settings, Trash2, Layers } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useConfig } from "../data/hooks/useConfig";
import { useChargePoints } from "../data/hooks/useChargePoints";
import { useDataContext } from "../data/providers/DataProvider";
import { useGlobalTagIds } from "../data/hooks/useGlobalTagIds";
import type { ChargePointSnapshot } from "../data/interfaces/ChargePointService";
import { getTemplateById } from "../utils/scenarioTemplates";
import type { Config } from "../store/store";
import { saveEditorScenario } from "./scenario/scenarioPersistence";

const DEFAULT_TAG_ID = "TAG001";

const TopPage: React.FC = () => {
  const { mode, chargePointService, scenarioRepository } = useDataContext();
  const { config, setConfig: persistConfig, isLoading } = useConfig();
  // Tag IDs live globally now — managed from the Settings page, not per-CP.
  // useGlobalTagIds picks the right backing store (config.Experimental in
  // local mode, a jotai atom in remote mode) and re-renders this tree when
  // Settings writes a new list.
  const { tagIds: tagIDs } = useGlobalTagIds();
  const [chargePointConfigs, setChargePointConfigs] = useState<
    ChargePointConfig[]
  >([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const { chargePoints, refresh } = useChargePoints(config, { isLoading });

  const updateConfig = useCallback(
    (next: Config | null) => {
      void persistConfig(next);
    },
    [persistConfig],
  );

  // rerender-dependencies: Use stable primitive key instead of object reference
  const configKey = useMemo(
    () => (config ? JSON.stringify(config) : null),
    [config],
  );

  // Remote mode: the daemon owns CP configuration, so we derive the edit
  // form's prefill from the snapshot's `config` block (POST/PUT /v1/cp echo)
  // rather than the local config store. Keyed on the full snapshot of each
  // CP's config (not just `id`) so a PUT edit that changes wsUrl / vendor /
  // boot-notification fields without changing the cpId still invalidates
  // the memo and rebuilds chargePointConfigs — otherwise the edit modal
  // would reopen with the previous values and a follow-up save would
  // silently revert the change.
  const chargePointsKey = useMemo(
    () =>
      chargePoints
        .map((c) => (c.config ? `${c.id}:${JSON.stringify(c.config)}` : c.id))
        .join("|"),
    [chargePoints],
  );

  useEffect(() => {
    // The local config drives the local tag list; in remote mode we keep
    // whatever the user persisted via the Add CP modal so Authorize / Start
    // Transaction still have a non-empty tag id after reload.
    if (mode === "remote") {
      // Remote: build config rows from the daemon snapshot. Fall back
      // safely when the daemon predates the `config` snapshot field so an
      // older deployment doesn't blank out the tab labels.
      const remoteConfigs: ChargePointConfig[] = chargePoints.map((cp) => {
        const c = cp.config;
        const bn = c?.bootNotification ?? null;
        return {
          cpId: cp.id,
          connectorNumber: c?.connectors ?? cp.connectors.length,
          wsURL: c?.wsUrl ?? "",
          ocppVersion: c?.ocppVersion ?? "OCPP-1.6J",
          basicAuthEnabled: !!c?.basicAuth,
          basicAuthUsername: c?.basicAuth?.username ?? "",
          basicAuthPassword: c?.basicAuth?.password ?? "",
          securityProfile: c?.securityProfile,
          cpoName: c?.cpoName,
          tlsCaPath: c?.tlsCaPath,
          tlsCertPath: c?.tlsCertPath,
          tlsKeyPath: c?.tlsKeyPath,
          autoMeterValueEnabled: false,
          autoMeterValueInterval: 30,
          autoMeterValue: 10,
          chargePointVendor: c?.vendor ?? "Vendor",
          chargePointModel: c?.model ?? "Model",
          firmwareVersion: bn?.firmwareVersion ?? "1.0",
          chargeBoxSerialNumber: bn?.chargeBoxSerialNumber ?? "",
          chargePointSerialNumber: bn?.chargePointSerialNumber ?? "",
          meterSerialNumber: bn?.meterSerialNumber ?? "",
          meterType: bn?.meterType ?? "",
          iccid: bn?.iccid ?? "",
          imsi: bn?.imsi ?? "",
        };
      });
      setChargePointConfigs(remoteConfigs);
      return;
    }

    if (isLoading || !config || !config.Experimental) {
      setChargePointConfigs([]);
      return;
    }

    const configs: ChargePointConfig[] = config.Experimental.ChargePointIDs.map(
      (cp) => ({
        cpId: cp.ChargePointID,
        connectorNumber: cp.ConnectorNumber,
        wsURL: config.wsURL,
        ocppVersion: config.ocppVersion,
        basicAuthEnabled: config.basicAuthSettings?.enabled || false,
        basicAuthUsername: config.basicAuthSettings?.username || "",
        basicAuthPassword: config.basicAuthSettings?.password || "",
        autoMeterValueEnabled: config.autoMeterValueSetting?.enabled || false,
        autoMeterValueInterval: config.autoMeterValueSetting?.interval || 30,
        autoMeterValue: config.autoMeterValueSetting?.value || 10,
        chargePointVendor:
          config.BootNotification?.chargePointVendor || "Vendor",
        chargePointModel: config.BootNotification?.chargePointModel || "Model",
        firmwareVersion: config.BootNotification?.firmwareVersion || "1.0",
        chargeBoxSerialNumber:
          config.BootNotification?.chargeBoxSerialNumber || "",
        chargePointSerialNumber:
          config.BootNotification?.chargePointSerialNumber || "",
        meterSerialNumber: config.BootNotification?.meterSerialNumber || "",
        meterType: config.BootNotification?.meterType || "",
        iccid: config.BootNotification?.iccid || "",
        imsi: config.BootNotification?.imsi || "",
      }),
    );
    setChargePointConfigs(configs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey, isLoading, mode, chargePointsKey]);

  const handleAddChargePoint = () => {
    setEditingIndex(null);
    setIsModalOpen(true);
  };

  const handleEditChargePoint = (index: number) => {
    setEditingIndex(index);
    setIsModalOpen(true);
  };

  const handleSaveChargePoint = async (cpConfig: ChargePointConfig) => {
    if (mode === "remote") {
      try {
        // Re-use the same shape for create and update; the only difference
        // is which daemon endpoint we hit. Editing an existing CP goes to
        // PUT /v1/cp/:cpId so the daemon can preserve persisted scenarios
        // (POST throws "cpId already exists" instead).
        const isEdit = editingIndex !== null;
        const params = {
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
        };
        if (isEdit && chargePointService.updateChargePoint) {
          await chargePointService.updateChargePoint(params);
        } else {
          await chargePointService.createChargePoint?.(params);
        }
        // The Add CP form exposes auto-meter settings, but the server's
        // POST /v1/cp body has no field for them. Apply them per-connector
        // after the CP exists so Remote-mode users get the same behaviour
        // they saw in the form.
        if (cpConfig.autoMeterValueEnabled) {
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
                    // The form's `autoMeterValue` is a single value; map it
                    // to the existing curve's last point so we don't have to
                    // restructure the schedule.
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
        }
        await refresh();
      } catch (err) {
        console.error("Failed to create remote CP", err);
        alert(
          `Failed to create CP: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    const updatedConfigs = [...chargePointConfigs];
    if (editingIndex !== null) {
      updatedConfigs[editingIndex] = cpConfig;
    } else {
      updatedConfigs.push(cpConfig);
    }
    setChargePointConfigs(updatedConfigs);

    const newConfig: Config = {
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
        ChargePointIDs: updatedConfigs.map((cfg) => ({
          ChargePointID: cfg.cpId,
          ConnectorNumber: cfg.connectorNumber,
        })),
        TagIDs: tagIDs,
      },
    };
    updateConfig(newConfig);

    // Brand-new local CP (not an edit): seed the Essential CP Behavior
    // template on every connector so the editor opens with the canonical demo
    // flow already loaded, mirroring the daemon's CPRegistry.create path.
    // Edits intentionally skip this — operators may have already tuned the
    // scenario and we'd clobber it.
    if (editingIndex === null && mode === "local") {
      const essential = getTemplateById("essential-cp-behavior");
      if (essential) {
        for (let cId = 1; cId <= cpConfig.connectorNumber; cId++) {
          const seeded = essential.createScenario(cpConfig.cpId, cId);
          void saveEditorScenario(
            {
              mode,
              chargePointService,
              scenarioRepository,
              cpId: cpConfig.cpId,
              connectorId: cId,
            },
            seeded,
          ).catch((err) =>
            console.warn(
              `Failed to seed Essential CP Behavior for ${cpConfig.cpId}/connector ${cId}`,
              err,
            ),
          );
        }
      }
    }
  };

  const handleDeleteChargePoint = async (cpId: string, index: number) => {
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

    const updatedConfigs = [...chargePointConfigs];
    updatedConfigs.splice(index, 1);
    setChargePointConfigs(updatedConfigs);

    if (updatedConfigs.length === 0) {
      updateConfig(null);
      return;
    }

    const newConfig: Config = {
      ...(config || {}),
      Experimental: {
        ChargePointIDs: updatedConfigs.map((cfg) => ({
          ChargePointID: cfg.cpId,
          ConnectorNumber: cfg.connectorNumber,
        })),
        TagIDs: tagIDs.length > 0 ? tagIDs : ["123456"],
      },
    };
    updateConfig(newConfig);
  };

  const effectiveTagIDs = tagIDs.length > 0 ? tagIDs : [DEFAULT_TAG_ID];

  return (
    <div className="px-8 pt-6 pb-8 mb-4">
      <ExperimentalView
        cps={chargePoints}
        chargePointConfigs={chargePointConfigs}
        tagIDs={effectiveTagIDs}
        onAddChargePoint={handleAddChargePoint}
        onEditChargePoint={handleEditChargePoint}
        onDeleteChargePoint={handleDeleteChargePoint}
      />

      <ChargePointConfigModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveChargePoint}
        mode={mode}
        initialConfig={
          editingIndex !== null
            ? chargePointConfigs[editingIndex]
            : defaultChargePointConfig
        }
        isNewChargePoint={editingIndex === null}
      />
    </div>
  );
};

interface ExperimentalProps {
  cps: ChargePointSnapshot[];
  chargePointConfigs: ChargePointConfig[];
  tagIDs: string[];
  onAddChargePoint: () => void;
  onEditChargePoint: (index: number) => void;
  onDeleteChargePoint: (cpId: string, index: number) => void;
}

const ExperimentalView: React.FC<ExperimentalProps> = ({
  cps,
  chargePointConfigs,
  tagIDs,
  onAddChargePoint,
  onEditChargePoint,
  onDeleteChargePoint,
}) => {
  const { chargePointService } = useDataContext();
  const [selectedTab, setSelectedTab] = useState<string>("");
  // Multi-CP bulk-ops dialog. Used to live as a row of inline buttons + a
  // Transaction-All panel above the tabs; that ate vertical space on every
  // session with ≥2 CPs even though most operators reach for those buttons
  // only occasionally. Folded behind a single header button instead.
  const [isMultiCpOpen, setIsMultiCpOpen] = useState(false);

  useEffect(() => {
    if (
      cps.length > 0 &&
      (!selectedTab || !cps.find((cp) => cp.id === selectedTab))
    ) {
      setSelectedTab(cps[0].id);
    }
  }, [cps, selectedTab]);

  const handleAllConnect = () => {
    cps.forEach((cp) => {
      void chargePointService.connect(cp.id).catch((err) => {
        console.error(`connect failed for ${cp.id}`, err);
      });
    });
  };

  const handleAllDisconnect = () => {
    cps.forEach((cp) => {
      void chargePointService.disconnect(cp.id).catch((err) => {
        console.error(`disconnect failed for ${cp.id}`, err);
      });
    });
  };

  const handleAllHeartbeat = () => {
    cps.forEach((cp) => {
      void chargePointService.sendHeartbeat(cp.id).catch((err) => {
        console.error(`heartbeat failed for ${cp.id}`, err);
      });
    });
  };

  const handleAllStartTransaction = () => {
    for (let i = 0; i < Math.min(tagIDs.length, cps.length); i++) {
      const cp = cps[i];
      const tagId = tagIDs[i];
      void chargePointService.startTransaction(cp.id, 1, tagId).catch((err) => {
        console.error(`startTransaction failed for ${cp.id}`, err);
      });
    }
  };

  const handleAllStopTransaction = () => {
    // We can't rely on cp.connectors[*].transactionId here — it's a
    // snapshot from useChargePoints and lags behind in-flight transactions
    // started via the adjacent "Start Transaction All" button. Fire stop
    // unconditionally for every known connector; the service no-ops cleanly
    // when nothing is active.
    cps.forEach((cp) => {
      cp.connectors.forEach((connector) => {
        void chargePointService
          .stopTransaction(cp.id, connector.id)
          .catch((err) => {
            console.error(`stopTransaction failed for ${cp.id}`, err);
          });
      });
    });
  };

  const hasMultipleCps = cps.length >= 2;
  const ocppVersionByCpId = useMemo(
    () =>
      new Map(
        chargePointConfigs.map((config) => [config.cpId, config.ocppVersion]),
      ),
    [chargePointConfigs],
  );

  return (
    <>
      <Tabs
        value={selectedTab}
        onValueChange={setSelectedTab}
        className="w-full"
      >
        <TabsList className="w-full justify-start flex-wrap h-auto">
          {cps.map((cp, key) => (
            <TabsTrigger
              key={cp.id}
              value={cp.id}
              className="flex items-center gap-2"
            >
              <span>{cp.id}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label="Edit Charge Point"
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon",
                  className: "h-6 w-6",
                })}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditChargePoint(key);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onEditChargePoint(key);
                  }
                }}
                title="Edit Charge Point"
              >
                <Settings className="h-3 w-3" />
              </span>
              <span
                role="button"
                tabIndex={0}
                aria-label="Delete Charge Point"
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon",
                  className: "h-6 w-6 text-destructive hover:text-destructive",
                })}
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Are you sure you want to delete ${cp.id}?`)) {
                    void onDeleteChargePoint(cp.id, key);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (confirm(`Are you sure you want to delete ${cp.id}?`)) {
                      void onDeleteChargePoint(cp.id, key);
                    }
                  }
                }}
                title="Delete Charge Point"
              >
                <Trash2 className="h-3 w-3" />
              </span>
            </TabsTrigger>
          ))}
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9"
            onClick={onAddChargePoint}
            title="Add Charge Point"
          >
            <Plus className="h-4 w-4" />
          </Button>
          {hasMultipleCps && (
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              onClick={() => setIsMultiCpOpen(true)}
              title="Multi-CP operations"
              aria-label="Multi-CP operations"
            >
              <Layers className="h-4 w-4" />
            </Button>
          )}
        </TabsList>
        {cps.map((cp) => (
          <TabsContent key={cp.id} value={cp.id}>
            <ChargePoint
              cpId={cp.id}
              TagID={tagIDs[0] ?? "TAG001"}
              tagIDs={tagIDs}
              ocppVersion={
                cp.config?.ocppVersion ?? ocppVersionByCpId.get(cp.id)
              }
            />
          </TabsContent>
        ))}
      </Tabs>

      <Dialog
        open={isMultiCpOpen}
        onOpenChange={(open) => setIsMultiCpOpen(open)}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Multi-CP operations</DialogTitle>
            <DialogDescription>
              Applies to all {cps.length} registered charge points.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Connection</h3>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleAllConnect}>Connect All</Button>
                <Button onClick={handleAllDisconnect} variant="destructive">
                  Disconnect All
                </Button>
                <Button onClick={handleAllHeartbeat} variant="info">
                  Send Heartbeat All
                </Button>
              </div>
            </section>

            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold">Transactions</h3>
                <span className="text-muted-foreground text-xs">
                  Tag IDs: {tagIDs.join(", ")}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleAllStartTransaction} variant="success">
                  Start Transaction All
                </Button>
                <Button onClick={handleAllStopTransaction} variant="warning">
                  Stop Transaction All
                </Button>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TopPage;
