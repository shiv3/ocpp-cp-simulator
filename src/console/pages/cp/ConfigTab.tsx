import React from "react";

import { Button } from "@/components/ui/button";
import type { ChargePointConfig } from "@/components/ChargePointConfigModal";

export interface ConfigTabProps {
  config: ChargePointConfig;
  mode: "local" | "remote";
  onEdit: () => void;
}

/**
 * Read-only view of the CP's current configuration. `config` is derived by
 * the caller (`CpDetailPage`'s `buildChargePointConfig`) from whichever
 * source currently owns it — the daemon's snapshot in remote mode, or the
 * shared local config in local mode — so this component stays a pure,
 * side-effect-free renderer. Secrets (basic-auth password, TLS material,
 * authorization key) are intentionally not displayed here.
 */
const ConfigTab: React.FC<ConfigTabProps> = ({ config, mode, onEdit }) => {
  const rows: Array<[string, React.ReactNode]> = [
    ["CP ID", config.cpId],
    ["Connectors", config.connectorNumber],
    ["WS URL", config.wsURL],
    ["OCPP version", config.ocppVersion],
    ["Vendor", config.chargePointVendor],
    ["Model", config.chargePointModel],
    [
      "Basic auth",
      config.basicAuthEnabled
        ? `Enabled (${config.basicAuthUsername})`
        : "Disabled",
    ],
  ];
  if (mode === "remote" && config.securityProfile != null) {
    rows.push(["Security profile", `SP${config.securityProfile}`]);
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {label}
            </dt>
            <dd className="break-all font-mono text-sm text-gray-900 dark:text-gray-100">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4">
        <Button type="button" variant="outline" size="sm" onClick={onEdit}>
          Edit config
        </Button>
      </div>
    </div>
  );
};

export default ConfigTab;
