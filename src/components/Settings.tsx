import React, { useState } from "react";
import { configAtom } from "../store/store.ts";
import { useAtom } from "jotai/index";
import { useNavigate } from "react-router-dom";
import { Card, Button, Textarea, Alert } from "flowbite-react";
import { HiDownload, HiUpload, HiHome } from "react-icons/hi";

const Settings: React.FC = () => {
  const [config, setConfig] = useAtom(configAtom);
  const [jsonText, setJsonText] = useState<string>(
    JSON.stringify(config, null, 2)
  );
  const [error, setError] = useState<string>("");
  const [success, setSuccess] = useState<string>("");
  const navigate = useNavigate();

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
        setConfig(json);
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
      setConfig(json);
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
        <h2 className="card-header">Settings</h2>
        <Button onClick={handleBackToHome} className="btn-secondary" size="sm">
          <HiHome className="mr-2 h-4 w-4" />
          Back to Home
        </Button>
      </div>

      {error && (
        <Alert color="failure" className="mb-4">
          {error}
        </Alert>
      )}

      {success && (
        <Alert color="success" className="mb-4">
          {success}
        </Alert>
      )}

      <Card className="card p-6">
        <div className="space-y-6">
          <div>
            <h3 className="card-header mb-4">Configuration Management</h3>
            <p className="text-secondary mb-4">
              Export your current configuration to a JSON file or import a previously saved configuration.
              You can also manually edit the JSON configuration below.
            </p>
          </div>

          <div className="flex gap-4">
            <Button onClick={handleExport} className="btn-success">
              <HiDownload className="mr-2 h-5 w-5" />
              Export Configuration
            </Button>

            <label htmlFor="file-upload" className="btn-primary cursor-pointer inline-flex items-center">
              <HiUpload className="mr-2 h-5 w-5" />
              Import Configuration
              <input
                id="file-upload"
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />
            </label>
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <h4 className="text-lg font-semibold text-primary">
                Configuration JSON
              </h4>
              <Button onClick={handleApplyJson} className="btn-primary" size="sm">
                Apply Changes
              </Button>
            </div>
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={20}
              className="font-mono text-sm logger-input"
              placeholder="Paste your configuration JSON here..."
            />
            <p className="text-muted text-xs mt-2">
              Edit the JSON configuration directly and click "Apply Changes" to update.
            </p>
          </div>

          <div className="card p-4 bg-blue-50 dark:bg-blue-900">
            <h4 className="text-sm font-semibold text-primary mb-2">
              Note
            </h4>
            <ul className="text-secondary text-sm space-y-1 list-disc list-inside">
              <li>Individual charge point settings can be configured from the Home page</li>
              <li>Click the gear icon next to each charge point tab to edit its settings</li>
              <li>Use the "+ Add Charge Point" button to add new charge points</li>
              <li>This page is for bulk configuration import/export only</li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default Settings;
