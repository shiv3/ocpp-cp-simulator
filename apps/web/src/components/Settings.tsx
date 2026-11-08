import { useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Upload, Home, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfig } from "../data/hooks/useConfig";
import { useGlobalTagIds } from "../data/hooks/useGlobalTagIds";
import { useDataContext } from "../data/providers/DataProvider";
import { useVehicleSelect } from "./vehicle/useVehicleSelect";
import { isPresetName, presetForDefaults } from "./vehicle/vehicleChoice";
import {
  OwnModelOption,
  VehicleChoiceNotes,
  VehicleProfileOptions,
} from "./vehicle/VehicleChoiceControls";
import {
  type EVSettings,
  EV_PRESETS,
  defaultEVSettings,
} from "@ocpp-cp-sim/core/cp/domain/connector/EVSettings";
import {
  DEFAULT_VOLTAGE_V,
  MIN_UI_POWER_FACTOR,
  withNormalizedChargingCurve,
} from "@ocpp-cp-sim/core/cp/domain/connector/ChargingCurve";

/**
 * The electrical values the Default EV Settings controls are showing, filled
 * in wherever the draft leaves one `undefined`.
 *
 * Each control renders a fallback — `currentType ?? "AC"`, `phases ?? 1`,
 * `voltageV ?? 230`, `powerFactor ?? 1` — so a user who never touches them
 * still sees a complete, specific electrical model. Saving that model is the
 * only reading of Apply that matches the page; leaving the fields unset would
 * silently select the legacy conversion instead (#301).
 *
 * `phases` and `powerFactor` are meaningless on DC and the controls for them
 * are disabled there, but the values displayed are saved anyway so that the
 * stored settings and the page never disagree; `resolveActivePhases` and
 * `effectivePowerFactor` both ignore them on DC.
 */
function displayedElectricalDefaults(draft: EVSettings): Partial<EVSettings> {
  return {
    currentType: draft.currentType ?? "AC",
    phases: draft.phases ?? 1,
    voltageV: draft.voltageV ?? DEFAULT_VOLTAGE_V,
    powerFactor: draft.powerFactor ?? 1,
  };
}

/**
 * Seed the editable draft with the model the controls will show.
 *
 * The draft is what Apply saves and what `evDirty` compares, so it has to hold
 * the same values the panel renders or the button that would change something
 * is disabled. Straight after load with no stored override — and straight
 * after Reset — the draft used to equal `defaultEVSettings` exactly, `evDirty`
 * was false, and Apply was greyed out: the page showed AC / single-phase /
 * 230 V / unity while the connector kept the legacy no-model conversion, which
 * reads an amp limit with no `numberPhases` as three-phase and reports 48 A
 * for a 16 A profile. Materializing the draft here makes it dirty against the
 * stored state precisely when the screen and the stored state disagree, which
 * is when Apply should be pressable (#301).
 */
function seedDraftEv(stored: EVSettings | null): EVSettings {
  const base = stored ?? { ...defaultEVSettings };
  return { ...base, ...displayedElectricalDefaults(base) };
}

const Settings: React.FC = () => {
  const { t } = useTranslation();
  const { config, setConfig: persistConfig, isLoading } = useConfig();
  const {
    mode,
    serverUrl,
    defaultEvSettings,
    setDefaultEvSettings,
    chargePointService,
  } = useDataContext();
  const [jsonText, setJsonText] = useState<string>("{}");
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const [draftEv, setDraftEv] = useState<EVSettings>(() =>
    seedDraftEv(defaultEvSettings),
  );
  // #458: saved vehicle profiles offered beside the presets.
  const vehicle = useVehicleSelect(draftEv, setDraftEv);
  const { tagIds: globalTagIds, setTagIds: persistGlobalTagIds } =
    useGlobalTagIds();
  // Draft string for the comma-separated input so the user can type literal
  // commas/spaces without each keystroke being eaten by split→filter→join.
  const [tagIdsDraft, setTagIdsDraft] = useState<string>("");
  const [tagIdsDirty, setTagIdsDirty] = useState<boolean>(false);
  useEffect(() => {
    if (!tagIdsDirty) {
      setTagIdsDraft(globalTagIds.join(", "));
    }
  }, [globalTagIds, tagIdsDirty]);
  const parseTagIdsDraft = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const handleApplyTagIds = async () => {
    const tags = parseTagIdsDraft(tagIdsDraft);
    await persistGlobalTagIds(tags);
    setTagIdsDraft(tags.join(", "));
    setTagIdsDirty(false);
    setSuccess(t("settings.page.tagsSaved"));
    setTimeout(() => setSuccess(""), 3000);
  };
  const navigate = useNavigate();

  useEffect(() => {
    setDraftEv(seedDraftEv(defaultEvSettings));
  }, [defaultEvSettings]);

  const [resetState, setResetState] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [resetError, setResetError] = useState<string | null>(null);
  const handleResetData = useCallback(async () => {
    if (!chargePointService.resetAllState) {
      setResetState("error");
      setResetError(t("settings.page.resetUnsupported"));
      return;
    }
    const proceed = window.confirm(t("settings.page.resetConfirm"));
    if (!proceed) return;
    setResetState("running");
    setResetError(null);
    try {
      await chargePointService.resetAllState();
      // Hard reload so every in-memory cache (Jotai store, repo
      // subscriber state, useChargePoints snapshot) starts fresh against
      // the now-empty DB.
      window.location.reload();
    } catch (err) {
      setResetState("error");
      setResetError(err instanceof Error ? err.message : String(err));
    }
  }, [chargePointService, t]);

  const handleApplyDefaultEv = () => {
    // Normalized here rather than relied on downstream: a fresh Connector
    // reads `getDefaultEVSettings()` straight into its field initializer,
    // bypassing the `evSettings` setter's normalization (#301).
    //
    // The four electrical fields are also materialized to exactly what the
    // controls display. Left `undefined` they made the form save something
    // other than what it showed: the panel reads "AC, single-phase, 230 V,
    // 1.0", but `electricalModelOf` saw no model at all and the domain fell
    // back to the pre-1.2 conversion, which reads an amp-based profile limit
    // as three-phase. A 16 A profile then metered as 48 A while the page
    // claimed single-phase. Apply now means what the page says (#301).
    setDefaultEvSettings(
      withNormalizedChargingCurve({
        ...draftEv,
        ...displayedElectricalDefaults(draftEv),
      }),
    );
    setSuccess(t("settings.page.evSaved"));
    setTimeout(() => setSuccess(""), 3000);
  };

  const handleResetDefaultEv = () => {
    setDefaultEvSettings(null);
    setSuccess(t("settings.page.evReset"));
    setTimeout(() => setSuccess(""), 3000);
  };

  const evDirty =
    JSON.stringify(draftEv) !==
    JSON.stringify(defaultEvSettings ?? defaultEVSettings);

  useEffect(() => {
    if (isLoading) return;
    if (config) {
      setJsonText(JSON.stringify(config, null, 2));
    } else {
      setJsonText("null");
    }
  }, [config, isLoading]);

  const updateConfig = useCallback(
    (next: Parameters<typeof persistConfig>[0]) => {
      void persistConfig(next);
    },
    [persistConfig],
  );

  const handleExport = () => {
    const dataStr = JSON.stringify(config, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ocpp-config-${new Date().toISOString().split("T")[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setSuccess(t("settings.page.exported"));
    setTimeout(() => setSuccess(""), 3000);
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);
        updateConfig(json);
        setJsonText(JSON.stringify(json, null, 2));
        setError("");
        setSuccess(t("settings.page.imported"));
        setTimeout(() => setSuccess(""), 3000);
      } catch {
        setError(t("settings.page.invalidFile"));
        setTimeout(() => setError(""), 5000);
      }
    };
    reader.readAsText(file);
  };

  const handleApplyJson = () => {
    try {
      const json = JSON.parse(jsonText);
      updateConfig(json);
      setError("");
      setSuccess(t("settings.page.applied"));
      setTimeout(() => setSuccess(""), 3000);
    } catch {
      setError(t("settings.page.invalidJson"));
      setTimeout(() => setError(""), 5000);
    }
  };

  const handleBackToHome = () => {
    // Relative navigation: from `/settings` (embedded in the web console)
    // it resolves to `/`. See apps/web/src/console/ConsoleApp.dom.test.tsx.
    navigate("..");
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">{t("settings.page.title")}</h2>
        <Button onClick={handleBackToHome} variant="secondary" size="sm">
          <Home className="mr-2 h-4 w-4" />
          {t("settings.page.backToHome")}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="mb-4 border-green-500 bg-green-50 dark:bg-green-900">
          <AlertDescription className="text-green-800 dark:text-green-100">
            {success}
          </AlertDescription>
        </Alert>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("settings.page.runtimeMode")}</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            {t("settings.page.runtimeModeBefore")}{" "}
            <code>ocpp-cp-sim --web-console</code>{" "}
            {t("settings.page.runtimeModeMid")} <code>bun run dev</code>
            {t("settings.page.runtimeModeAfter")}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="text-sm">
            {t("settings.page.mode")}{" "}
            <span className="font-semibold">{mode}</span>
          </div>
          {mode === "remote" && (
            <div className="text-xs text-muted-foreground font-mono">
              {t("settings.page.server", { url: serverUrl })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6 border-destructive/40">
        <CardHeader>
          <CardTitle>{t("settings.page.resetData")}</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            {t("settings.page.resetDataHelp")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="destructive"
            disabled={resetState !== "idle"}
            onClick={handleResetData}
          >
            {resetState === "running"
              ? t("settings.page.resetting")
              : t("settings.page.resetAll")}
          </Button>
          {resetState === "error" && (
            <Alert variant="destructive">
              <AlertDescription>
                {resetError ?? t("settings.page.resetFailed")}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("settings.page.defaultEv")}</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            {t("settings.page.defaultEvHelp")}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label
              htmlFor="default-ev-preset"
              className="block text-sm font-semibold mb-2"
            >
              {t("settings.page.evPreset")}
            </label>
            <select
              id="default-ev-preset"
              value={draftEv.modelName || "Custom"}
              onChange={(e) => {
                const preset = e.target.value;
                vehicle.select(preset, (base) =>
                  isPresetName(preset) && preset !== "Custom"
                    ? presetForDefaults(base, preset)
                    : { ...base, modelName: preset },
                );
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            >
              <OwnModelOption modelName={draftEv.modelName} />
              <VehicleProfileOptions state={vehicle.profiles} />
              {Object.keys(EV_PRESETS).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <VehicleChoiceNotes notes={vehicle.notes} className="mt-1.5" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1">
                {t("settings.page.battery")}
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={draftEv.batteryCapacityKwh}
                onChange={(e) =>
                  setDraftEv({
                    ...draftEv,
                    batteryCapacityKwh: Math.max(
                      1,
                      parseFloat(e.target.value) ||
                        defaultEVSettings.batteryCapacityKwh,
                    ),
                  })
                }
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">
                {t("settings.page.maxPower")}
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={draftEv.maxChargingPowerKw}
                onChange={(e) =>
                  setDraftEv({
                    ...draftEv,
                    maxChargingPowerKw: Math.max(
                      1,
                      parseFloat(e.target.value) ||
                        defaultEVSettings.maxChargingPowerKw,
                    ),
                  })
                }
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">
                {t("settings.page.initialSoc")}
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={draftEv.initialSoc}
                onChange={(e) =>
                  setDraftEv({
                    ...draftEv,
                    initialSoc: Math.min(
                      100,
                      Math.max(0, parseInt(e.target.value) || 0),
                    ),
                  })
                }
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1">
                {t("settings.page.targetSoc")}
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={draftEv.targetSoc}
                onChange={(e) =>
                  setDraftEv({
                    ...draftEv,
                    targetSoc: Math.min(
                      100,
                      Math.max(0, parseInt(e.target.value) || 80),
                    ),
                  })
                }
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
              />
            </div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-2">
              {t("settings.page.electrical")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="default-ev-current-type"
                  className="block text-xs font-semibold mb-1"
                >
                  {t("settings.page.currentType")}
                </label>
                <select
                  id="default-ev-current-type"
                  value={draftEv.currentType ?? "AC"}
                  onChange={(e) => {
                    const currentType = e.target.value as "AC" | "DC";
                    setDraftEv({
                      ...draftEv,
                      currentType,
                      // DC has no phases; drop a stale 3-phase setting so it
                      // doesn't linger unused if the user switches back.
                      phases: currentType === "DC" ? undefined : draftEv.phases,
                    });
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                >
                  <option value="AC">AC</option>
                  <option value="DC">DC</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="default-ev-phases"
                  className="block text-xs font-semibold mb-1"
                >
                  {t("settings.page.phases")}
                </label>
                <select
                  id="default-ev-phases"
                  value={String(draftEv.phases ?? 1)}
                  disabled={draftEv.currentType === "DC"}
                  onChange={(e) =>
                    setDraftEv({
                      ...draftEv,
                      phases: (e.target.value === "3" ? 3 : 1) as 1 | 3,
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                >
                  <option value="1">{t("settings.page.phase1")}</option>
                  <option value="3">{t("settings.page.phase3")}</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="default-ev-voltage"
                  className="block text-xs font-semibold mb-1"
                >
                  {t("settings.page.voltage")}
                </label>
                <input
                  id="default-ev-voltage"
                  type="number"
                  min={1}
                  step={1}
                  value={draftEv.voltageV ?? 230}
                  onChange={(e) =>
                    setDraftEv({
                      ...draftEv,
                      voltageV: Math.max(1, parseFloat(e.target.value) || 230),
                    })
                  }
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label
                  htmlFor="default-ev-power-factor"
                  className="block text-xs font-semibold mb-1"
                >
                  {t("settings.page.powerFactor")}
                </label>
                <input
                  id="default-ev-power-factor"
                  type="number"
                  min={MIN_UI_POWER_FACTOR}
                  max={1}
                  step={0.01}
                  value={draftEv.powerFactor ?? 1}
                  disabled={draftEv.currentType === "DC"}
                  onChange={(e) => {
                    // Clamped to MIN_UI_POWER_FACTOR, never 0: a cos phi of 0
                    // means no real power flows, so the derived current would
                    // be infinite. The domain would fall back to unity, which
                    // is not what someone typing 0 asked for (#301).
                    const parsed = parseFloat(e.target.value);
                    setDraftEv({
                      ...draftEv,
                      powerFactor: Number.isFinite(parsed)
                        ? Math.min(1, Math.max(MIN_UI_POWER_FACTOR, parsed))
                        : 1,
                    });
                  }}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-1">
              {t("settings.page.chargingCurve")}
            </p>
            <p className="text-muted-foreground text-xs mb-2">
              {t("settings.page.chargingCurveHelp")}
            </p>
            <div className="space-y-2">
              {(draftEv.chargingCurve ?? []).map((point, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    aria-label={t("settings.page.curveSocAria", {
                      index: index + 1,
                    })}
                    value={point.socPercent}
                    onChange={(e) => {
                      const curve = [...(draftEv.chargingCurve ?? [])];
                      curve[index] = {
                        ...curve[index]!,
                        socPercent: Math.min(
                          100,
                          Math.max(0, parseFloat(e.target.value) || 0),
                        ),
                      };
                      setDraftEv({ ...draftEv, chargingCurve: curve });
                    }}
                    className="w-24 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("settings.page.curveSocUnit")}
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    aria-label={t("settings.page.curveFractionAria", {
                      index: index + 1,
                    })}
                    value={point.powerFraction}
                    onChange={(e) => {
                      const curve = [...(draftEv.chargingCurve ?? [])];
                      curve[index] = {
                        ...curve[index]!,
                        powerFraction: Math.min(
                          1,
                          Math.max(0, parseFloat(e.target.value) || 0),
                        ),
                      };
                      setDraftEv({ ...draftEv, chargingCurve: curve });
                    }}
                    className="w-24 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("settings.page.curveFractionUnit")}
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label={t("settings.page.curveRemoveAria", {
                      index: index + 1,
                    })}
                    onClick={() => {
                      const curve = (draftEv.chargingCurve ?? []).filter(
                        (_, i) => i !== index,
                      );
                      setDraftEv({
                        ...draftEv,
                        chargingCurve: curve.length > 0 ? curve : undefined,
                      });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  setDraftEv({
                    ...draftEv,
                    chargingCurve: [
                      ...(draftEv.chargingCurve ?? []),
                      { socPercent: 0, powerFraction: 1 },
                    ],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t("settings.page.addPoint")}
              </Button>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={handleApplyDefaultEv}
              disabled={!evDirty}
              size="sm"
            >
              {t("settings.common.save")}
            </Button>
            <Button
              onClick={handleResetDefaultEv}
              disabled={!defaultEvSettings}
              variant="secondary"
              size="sm"
            >
              {t("settings.page.resetBuiltIn")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {defaultEvSettings
              ? t("settings.page.overrideActive")
              : t("settings.page.noOverride")}
          </p>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("settings.page.rfid")}</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            {t("settings.page.rfidHelp")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <label
            htmlFor="global-tag-ids"
            className="block text-sm font-semibold"
          >
            {t("settings.page.tagIds")}
          </label>
          <input
            id="global-tag-ids"
            type="text"
            value={tagIdsDraft}
            onChange={(e) => {
              setTagIdsDraft(e.target.value);
              setTagIdsDirty(true);
            }}
            onBlur={() => {
              const tags = parseTagIdsDraft(tagIdsDraft);
              setTagIdsDraft(tags.join(", "));
            }}
            placeholder={t("settings.page.tagIdsPlaceholder")}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono"
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={() => void handleApplyTagIds()}
              size="sm"
              disabled={
                !tagIdsDirty &&
                parseTagIdsDraft(tagIdsDraft).join("|") ===
                  globalTagIds.join("|")
              }
            >
              {t("settings.common.save")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {globalTagIds.length === 0
                ? t("settings.page.noTags")
                : t("settings.page.tagsActive", {
                    count: globalTagIds.length,
                  })}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.page.configMgmt")}</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            {t("settings.page.configMgmtHelp")}
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex gap-4">
            <Button onClick={handleExport} variant="success">
              <Download className="mr-2 h-5 w-5" />
              {t("settings.page.export")}
            </Button>

            <Button asChild>
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="mr-2 h-5 w-5" />
                {t("settings.page.import")}
                <input
                  id="file-upload"
                  type="file"
                  accept=".json"
                  onChange={handleImport}
                  className="hidden"
                />
              </label>
            </Button>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <h4 className="text-lg font-semibold">
                {t("settings.page.configJson")}
              </h4>
              <Button onClick={handleApplyJson} size="sm">
                {t("settings.common.save")}
              </Button>
            </div>
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={20}
              className="font-mono text-sm"
              placeholder={t("settings.page.jsonPlaceholder")}
            />
            <p className="text-muted-foreground text-xs mt-2">
              {t("settings.page.jsonHelp")}
            </p>
          </div>

          <Card className="bg-blue-50 dark:bg-blue-950/50">
            <CardContent className="pt-6">
              <h4 className="text-sm font-semibold mb-2">
                {t("settings.page.note")}
              </h4>
              <ul className="text-muted-foreground text-sm space-y-1 list-disc list-inside">
                <li>{t("settings.page.note1")}</li>
                <li>{t("settings.page.note2")}</li>
                <li>{t("settings.page.note3")}</li>
                <li>{t("settings.page.note4")}</li>
              </ul>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  );
};

export default Settings;
