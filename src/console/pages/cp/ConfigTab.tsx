import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import type {
  ChargePointConfig,
  SoapPublicBase,
} from "@/components/ChargePointConfigModal";
import { isSoapVersion } from "@/cp/domain/types/OcppVersion";

export interface ConfigTabProps {
  config: ChargePointConfig;
  mode: "local" | "remote";
  /** `server.info`'s `soap` block; names the tunnel a derived URL came from. */
  soapPublicBase?: SoapPublicBase | null;
  onEdit: () => void;
}

/**
 * The SOAP callback URL is the one value the operator has to carry over to
 * the CSMS by hand, so it gets a copy button. When the daemon derived it
 * from a tunnel, say so: a free-tier ngrok URL changes between runs, and the
 * CSMS entry has to follow it.
 */
const SoapCallbackUrlRow: React.FC<{
  url: string;
  derived: boolean;
  soapPublicBase: SoapPublicBase | null | undefined;
}> = ({ url, derived, soapPublicBase }) => {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copy = async () => {
    try {
      // Absent on plain-http origins other than localhost; the URL stays
      // selectable as text, so say so instead of failing silently.
      await navigator.clipboard.writeText(url);
      setCopyState("copied");
    } catch (error) {
      console.error("Failed to copy the SOAP callback URL", error);
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  };
  const source = derived
    ? soapPublicBase?.tunnel
      ? `derived from the ${soapPublicBase.tunnel.provider} tunnel — the URL may change between daemon runs`
      : "derived from the daemon's SOAP public base"
    : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <span className="break-all">{url}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label="Copy SOAP callback URL"
        >
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy"}
        </Button>
      </div>
      {source && (
        <span className="font-sans text-xs text-gray-500 dark:text-gray-400">
          {source}
        </span>
      )}
    </div>
  );
};

/**
 * Read-only view of the CP's current configuration. `config` is derived by
 * the caller (`CpDetailPage`'s `buildChargePointConfig`) from whichever
 * source currently owns it — the daemon's snapshot in remote mode, or the
 * shared local config in local mode — so this component stays a pure,
 * side-effect-free renderer. Secrets (basic-auth password, TLS material,
 * authorization key) are intentionally not displayed here.
 */
const ConfigTab: React.FC<ConfigTabProps> = ({
  config,
  mode,
  soapPublicBase,
  onEdit,
}) => {
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
  if (isSoapVersion(config.ocppVersion) && config.soapCallbackUrl) {
    rows.push([
      "SOAP callback URL",
      <SoapCallbackUrlRow
        key="soap-callback-url"
        url={config.soapCallbackUrl}
        derived={config.soapCallbackUrlDerived === true}
        soapPublicBase={soapPublicBase}
      />,
    ]);
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
