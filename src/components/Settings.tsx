import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Upload, Home } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfig } from "../data/hooks/useConfig";
import { useDataContext } from "../data/providers/DataProvider";

const Settings: React.FC = () => {
  const { config, setConfig: persistConfig, isLoading } = useConfig();
  const { mode, serverUrl, setMode, setServerUrl } = useDataContext();
  const [jsonText, setJsonText] = useState<string>("{}");
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const [draftUrl, setDraftUrl] = useState<string>(serverUrl);
  const navigate = useNavigate();

  useEffect(() => {
    setDraftUrl(serverUrl);
  }, [serverUrl]);

  const handleApplyServerUrl = () => {
    const trimmed = draftUrl.trim();
    if (!trimmed) {
      setError("Remote server URL cannot be empty.");
      setTimeout(() => setError(""), 5000);
      return;
    }
    setServerUrl(trimmed);
    setSuccess("Remote server URL updated.");
    setTimeout(() => setSuccess(""), 3000);
  };

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
            Choose whether the simulator runs the charge points in the browser
            (Local) or controls a long-running <code>cp-sim</code> daemon via
            HTTP/WebSocket (Remote). The selection persists in localStorage.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-sm font-semibold mb-2">Mode</div>
            <div className="inline-flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setMode("local")}
                className={`px-4 py-1.5 text-sm rounded transition-colors ${
                  mode === "local"
                    ? "bg-blue-600 text-white"
                    : "text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => setMode("remote")}
                className={`px-4 py-1.5 text-sm rounded transition-colors ${
                  mode === "remote"
                    ? "bg-blue-600 text-white"
                    : "text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                }`}
              >
                Remote
              </button>
            </div>
            <p className="text-muted-foreground text-xs mt-2">
              Current: <span className="font-semibold">{mode}</span>
            </p>
          </div>

          <div>
            <label
              htmlFor="remote-server-url"
              className="block text-sm font-semibold mb-2"
            >
              Remote server URL
            </label>
            <div className="flex gap-2">
              <input
                id="remote-server-url"
                type="text"
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                placeholder="http://127.0.0.1:9700"
                className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono"
              />
              <Button
                onClick={handleApplyServerUrl}
                disabled={draftUrl.trim() === serverUrl.trim()}
                size="sm"
              >
                Apply
              </Button>
            </div>
            <p className="text-muted-foreground text-xs mt-2">
              Used when mode is set to <strong>Remote</strong>. Point this at a
              running <code>cp-sim --http-port</code> daemon (default{" "}
              <code>http://127.0.0.1:9700</code>).
            </p>
          </div>
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
