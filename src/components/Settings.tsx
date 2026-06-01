import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Upload, Home } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfig } from "../data/hooks/useConfig";
import { useDataContext } from "../data/providers/DataProvider";
import {
  type EVSettings,
  EV_PRESETS,
  defaultEVSettings,
} from "../cp/domain/connector/EVSettings";

const Settings: React.FC = () => {
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
  const [draftEv, setDraftEv] = useState<EVSettings>(
    defaultEvSettings ?? { ...defaultEVSettings },
  );
  const navigate = useNavigate();

  useEffect(() => {
    setDraftEv(defaultEvSettings ?? { ...defaultEVSettings });
  }, [defaultEvSettings]);

  const [resetState, setResetState] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [resetError, setResetError] = useState<string | null>(null);
  const handleResetData = useCallback(async () => {
    if (!chargePointService.resetAllState) {
      setResetState("error");
      setResetError("This runtime does not support state reset");
      return;
    }
    const proceed = window.confirm(
      "Reset all simulator data?\n\n" +
        "Scenarios, configuration overrides, charging profiles, " +
        "availability flags, pending messages and logs will be erased. " +
        "The page will reload afterwards.",
    );
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
  }, [chargePointService]);

  const handleApplyDefaultEv = () => {
    setDefaultEvSettings(draftEv);
    setSuccess(
      "Default EV settings saved. New connectors will start with these values.",
    );
    setTimeout(() => setSuccess(""), 3000);
  };

  const handleResetDefaultEv = () => {
    setDefaultEvSettings(null);
    setSuccess("Default EV settings reset to the built-in defaults.");
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
    setSuccess("Configuration exported successfully!");
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
        setSuccess("Configuration imported successfully!");
        setTimeout(() => setSuccess(""), 3000);
      } catch (err) {
        setError("Invalid JSON file. Please check the file format.");
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
      setSuccess("Configuration applied successfully!");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError("Invalid JSON. Please check the syntax.");
      setTimeout(() => setError(""), 5000);
    }
  };

  const handleBackToHome = () => {
    navigate("/");
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold">Settings</h2>
        <Button onClick={handleBackToHome} variant="secondary" size="sm">
          <Home className="mr-2 h-4 w-4" />
          Back to Home
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
          <CardTitle>Runtime Mode</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            The simulator picks Local or Remote automatically based on where the
            UI is served from. When opened via{" "}
            <code>ocpp-cp-sim --web-console</code> (or the Docker image) the UI
            talks to that daemon as Remote; when opened from a static build
            (GitHub Pages, <code>bun run dev</code>) it runs the charge points
            in-browser as Local. No manual toggle.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="text-sm">
            Mode: <span className="font-semibold">{mode}</span>
          </div>
          {mode === "remote" && (
            <div className="text-xs text-muted-foreground font-mono">
              Server: {serverUrl}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6 border-destructive/40">
        <CardHeader>
          <CardTitle>Reset data</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            Wipe every persisted simulator record — scenarios,
            ChangeConfiguration overrides, charging profiles, availability
            flags, pending transaction messages and any saved logs. Schema stays
            intact; the next load starts from a clean DB. In remote mode this
            also drops every charge point registered on the daemon.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="destructive"
            disabled={resetState !== "idle"}
            onClick={handleResetData}
          >
            {resetState === "running"
              ? "Resetting…"
              : "Reset all simulator data"}
          </Button>
          {resetState === "error" && (
            <Alert variant="destructive">
              <AlertDescription>
                {resetError ?? "Reset failed"}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Default EV Settings</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            These values seed every new connector's EV (battery capacity, target
            SoC, etc.) on this device. Scenarios that leave their "Scenario EV
            Settings" fields empty fall back to whatever the connector currently
            holds — which starts from this default.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label
              htmlFor="default-ev-preset"
              className="block text-sm font-semibold mb-2"
            >
              EV Model preset
            </label>
            <select
              id="default-ev-preset"
              value={
                Object.keys(EV_PRESETS).includes(draftEv.modelName)
                  ? draftEv.modelName
                  : "Custom"
              }
              onChange={(e) => {
                const preset = e.target.value;
                if (preset === "Custom") {
                  setDraftEv({ ...draftEv, modelName: "Custom" });
                  return;
                }
                const values = EV_PRESETS[preset] ?? {};
                setDraftEv({ ...draftEv, modelName: preset, ...values });
              }}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            >
              {Object.keys(EV_PRESETS).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1">
                Battery (kWh)
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
                Max Power (kW)
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
                Initial SoC (%)
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
                Target SoC (%)
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

          <div className="flex gap-2">
            <Button
              onClick={handleApplyDefaultEv}
              disabled={!evDirty}
              size="sm"
            >
              Apply
            </Button>
            <Button
              onClick={handleResetDefaultEv}
              disabled={!defaultEvSettings}
              variant="secondary"
              size="sm"
            >
              Reset to built-in
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {defaultEvSettings
              ? "User override is active. New connectors will start from these values."
              : "No override. New connectors start from the built-in Generic EV defaults (75 kWh / 80 % target)."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration Management</CardTitle>
          <p className="text-muted-foreground text-sm mt-2">
            Export your current configuration to a JSON file or import a
            previously saved configuration. You can also manually edit the JSON
            configuration below.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex gap-4">
            <Button onClick={handleExport} variant="success">
              <Download className="mr-2 h-5 w-5" />
              Export Configuration
            </Button>

            <Button asChild>
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="mr-2 h-5 w-5" />
                Import Configuration
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
              <h4 className="text-lg font-semibold">Configuration JSON</h4>
              <Button onClick={handleApplyJson} size="sm">
                Apply Changes
              </Button>
            </div>
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={20}
              className="font-mono text-sm"
              placeholder="Paste your configuration JSON here..."
            />
            <p className="text-muted-foreground text-xs mt-2">
              Edit the JSON configuration directly and click "Apply Changes" to
              update.
            </p>
          </div>

          <Card className="bg-blue-50 dark:bg-blue-950/50">
            <CardContent className="pt-6">
              <h4 className="text-sm font-semibold mb-2">Note</h4>
              <ul className="text-muted-foreground text-sm space-y-1 list-disc list-inside">
                <li>
                  Individual charge point settings can be configured from the
                  Home page
                </li>
                <li>
                  Click the gear icon next to each charge point tab to edit its
                  settings
                </li>
                <li>
                  Use the "+ Add Charge Point" button to add new charge points
                </li>
                <li>This page is for bulk configuration import/export only</li>
              </ul>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  );
};

export default Settings;
