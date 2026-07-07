import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Save, X } from "lucide-react";
import { buildFullOcppUrl, parseFullOcppUrl } from "../utils/ocppUrl";
import { BROWSER_TLS_UNSUPPORTED_MESSAGE } from "../data/interfaces/UnsupportedFeatureError";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../cp/infrastructure/transport/wsUrlWithBasic";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export interface ChargePointConfig {
  cpId: string;
  connectorNumber: number;
  wsURL: string;
  ocppVersion: string;
  basicAuthEnabled: boolean;
  basicAuthUsername: string;
  basicAuthPassword: string;
  autoMeterValueEnabled: boolean;
  autoMeterValueInterval: number;
  autoMeterValue: number;
  chargePointVendor: string;
  chargePointModel: string;
  firmwareVersion: string;
  chargeBoxSerialNumber: string;
  chargePointSerialNumber: string;
  meterSerialNumber: string;
  meterType: string;
  iccid: string;
  imsi: string;
  soapCallbackUrl?: string;
  soapPath?: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  cpoName?: string;
  tls?: OcppTlsOptions;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

interface ChargePointConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: ChargePointConfig) => void;
  initialConfig?: ChargePointConfig;
  isNewChargePoint?: boolean;
  /**
   * Active runtime mode. Currently used only to label and disable a few
   * fields that don't have a remote equivalent yet (e.g. the local tag list).
   */
  mode?: "local" | "remote";
}

/**
 * Strip blank secret-ish fields before handing the config to `onSave`.
 * Remote mode's cp.update merge only preserves a field that is entirely
 * *absent* from the request params (see socketServer.ts's
 * `mergeUpdateParams`), so a blank input here must become `undefined` (not
 * `""`) — otherwise "leave blank to keep current" would silently wipe the
 * daemon's stored authorizationKey / TLS cert / TLS key on every edit.
 */
export function sanitizeChargePointConfigForSave(
  config: ChargePointConfig,
): ChargePointConfig {
  return {
    ...config,
    soapCallbackUrl: config.soapCallbackUrl?.trim() || undefined,
    soapPath: config.soapPath?.trim() || undefined,
    authorizationKey: config.authorizationKey?.trim() || undefined,
    tls: sanitizeTlsForSave(config.tls),
  };
}

function sanitizeTlsForSave(
  tls: OcppTlsOptions | undefined,
): OcppTlsOptions | undefined {
  if (!tls) return undefined;
  const result: OcppTlsOptions = {
    ...(tls.ca?.trim() ? { ca: tls.ca } : {}),
    ...(tls.cert?.trim() ? { cert: tls.cert } : {}),
    ...(tls.key?.trim() ? { key: tls.key } : {}),
    ...(tls.serverName?.trim() ? { serverName: tls.serverName } : {}),
    ...(tls.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: tls.rejectUnauthorized }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export const defaultChargePointConfig: ChargePointConfig = {
  cpId: "CP001",
  connectorNumber: 1,
  wsURL: "ws://localhost:8080/steve/websocket/CentralSystemService/",
  ocppVersion: "OCPP-1.6J",
  basicAuthEnabled: false,
  basicAuthUsername: "",
  basicAuthPassword: "",
  autoMeterValueEnabled: false,
  autoMeterValueInterval: 30,
  autoMeterValue: 10,
  chargePointVendor: "Vendor",
  chargePointModel: "Model",
  firmwareVersion: "1.0",
  chargeBoxSerialNumber: "123456",
  chargePointSerialNumber: "123456",
  meterSerialNumber: "123456",
  meterType: "",
  iccid: "",
  imsi: "",
  securityProfile: 0,
};

const ChargePointConfigModal: React.FC<ChargePointConfigModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialConfig,
  isNewChargePoint = false,
  mode = "local",
}) => {
  const [config, setConfig] = useState<ChargePointConfig>(
    initialConfig || defaultChargePointConfig,
  );

  useEffect(() => {
    if (initialConfig) {
      setConfig(initialConfig);
    }
  }, [initialConfig]);

  const handleSave = () => {
    const profile = config.securityProfile ?? 0;
    const hasTlsMaterial = Boolean(
      config.tls?.ca || config.tls?.cert || config.tls?.key,
    );
    if (
      mode === "local" &&
      (profile === 2 || profile === 3 || hasTlsMaterial)
    ) {
      setFullUrlError(BROWSER_TLS_UNSUPPORTED_MESSAGE);
      return;
    }
    if (
      mode === "remote" &&
      config.ocppVersion === "OCPP-1.5" &&
      !config.soapCallbackUrl?.trim()
    ) {
      setSaveError("SOAP Callback URL is required for OCPP 1.5.");
      return;
    }
    if (
      mode === "remote" &&
      profile === 3 &&
      isNewChargePoint &&
      !(config.tls?.cert?.trim() && config.tls?.key?.trim())
    ) {
      setSaveError(
        "Security profile 3 (mutual TLS) requires a client certificate and private key.",
      );
      return;
    }
    setSaveError(null);
    onSave(sanitizeChargePointConfigForSave(config));
    onClose();
  };

  const updateConfig = (
    key: keyof ChargePointConfig,
    value: ChargePointConfig[keyof ChargePointConfig],
  ) => {
    setConfig({ ...config, [key]: value });
  };

  const updateTls = (patch: Partial<OcppTlsOptions>) => {
    setConfig((prev) => ({ ...prev, tls: { ...prev.tls, ...patch } }));
  };

  // Full WebSocket URL field — built from wsURL + basic auth on display,
  // and parsed back into those fields on paste/Enter/blur. `fullUrlDraft`
  // lets the user type without each keystroke fighting the composed value.
  const composedFullUrl = useMemo(
    () =>
      buildFullOcppUrl(config.wsURL, {
        enabled: config.basicAuthEnabled,
        username: config.basicAuthUsername,
        password: config.basicAuthPassword,
      }),
    [
      config.wsURL,
      config.basicAuthEnabled,
      config.basicAuthUsername,
      config.basicAuthPassword,
    ],
  );
  const [fullUrlDraft, setFullUrlDraft] = useState<string | null>(null);
  const [fullUrlError, setFullUrlError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const displayFullUrl = fullUrlDraft ?? composedFullUrl;
  const securityProfile = config.securityProfile ?? 0;

  const applyFullUrl = useCallback((raw: string): boolean => {
    const parsed = parseFullOcppUrl(raw);
    if (!parsed) {
      setFullUrlError(
        "Invalid WebSocket URL. Use a full ws:// or wss:// URL (optionally with user:password@host for basic auth).",
      );
      return false;
    }
    setConfig((prev) => ({
      ...prev,
      wsURL: parsed.wsURL,
      basicAuthEnabled: parsed.basicAuthEnabled || prev.basicAuthEnabled,
      basicAuthUsername: parsed.basicAuthEnabled
        ? parsed.basicAuthUsername
        : prev.basicAuthUsername,
      basicAuthPassword: parsed.basicAuthEnabled
        ? parsed.basicAuthPassword
        : prev.basicAuthPassword,
    }));
    setFullUrlDraft(null);
    setFullUrlError(null);
    return true;
  }, []);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNewChargePoint
              ? "Add New Charge Point"
              : `Configure ${config.cpId}`}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-4">
          {/* Basic Settings */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Basic Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="cpId" className="mb-2 logger-label">
                  Charge Point ID
                </Label>
                <Input
                  id="cpId"
                  type="text"
                  value={config.cpId}
                  onChange={(e) => updateConfig("cpId", e.target.value)}
                  required
                  // cpId is the primary key for both local-mode config and
                  // the daemon's CP registry; changing it on an existing CP
                  // would be "delete + recreate" semantics, not "edit". Lock
                  // it down in edit mode so the operator doesn't accidentally
                  // strand the previous CP — they can delete + re-add if
                  // they really need a different id.
                  readOnly={!isNewChargePoint}
                  disabled={!isNewChargePoint}
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="connectorNumber" className="mb-2 logger-label">
                  Number of Connectors
                </Label>
                <Input
                  id="connectorNumber"
                  type="number"
                  min="1"
                  max="10"
                  value={config.connectorNumber}
                  onChange={(e) =>
                    updateConfig("connectorNumber", parseInt(e.target.value))
                  }
                  required
                  className="logger-input"
                />
              </div>
              {config.ocppVersion !== "OCPP-1.5" && (
                <div className="col-span-2">
                  <Label htmlFor="fullWsURL" className="mb-2 logger-label">
                    Full WebSocket URL
                  </Label>
                  <Input
                    id="fullWsURL"
                    type="url"
                    value={displayFullUrl}
                    onChange={(e) => {
                      setFullUrlDraft(e.target.value);
                      setFullUrlError(null);
                    }}
                    onBlur={() => {
                      if (fullUrlDraft !== null) applyFullUrl(fullUrlDraft);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (fullUrlDraft !== null) applyFullUrl(fullUrlDraft);
                      }
                    }}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text").trim();
                      if (!text) return;
                      e.preventDefault();
                      setFullUrlDraft(text);
                      applyFullUrl(text);
                    }}
                    placeholder="wss://user:password@host:8080/path/"
                    className="logger-input font-mono text-sm"
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted mt-1">
                    Composed from WebSocket URL + Basic Auth below. Paste a full
                    URL to autofill those fields (basic auth from
                    user:password@host).
                  </p>
                  {fullUrlError && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                      {fullUrlError}
                    </p>
                  )}
                </div>
              )}
              <div className="col-span-2">
                <Label htmlFor="wsURL" className="mb-2 logger-label">
                  {config.ocppVersion === "OCPP-1.5"
                    ? "Central System URL (SOAP endpoint)"
                    : "WebSocket URL"}
                </Label>
                <Input
                  id="wsURL"
                  type="url"
                  value={config.wsURL}
                  onChange={(e) => updateConfig("wsURL", e.target.value)}
                  required
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="ocppVersion" className="mb-2">
                  OCPP Version
                </Label>
                <Select
                  value={config.ocppVersion}
                  onValueChange={(value) => updateConfig("ocppVersion", value)}
                >
                  <SelectTrigger id="ocppVersion">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {mode === "remote" && (
                      <SelectItem value="OCPP-1.5">OCPP 1.5 (SOAP)</SelectItem>
                    )}
                    <SelectItem value="OCPP-1.6J">OCPP 1.6J</SelectItem>
                    <SelectItem value="OCPP-2.0.1">OCPP 2.0.1</SelectItem>
                    <SelectItem value="OCPP-2.1">OCPP 2.1</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {mode === "remote" && config.ocppVersion === "OCPP-1.5" && (
                <div className="col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label
                      htmlFor="soapCallbackUrl"
                      className="mb-2 logger-label"
                    >
                      SOAP Callback URL
                    </Label>
                    <Input
                      id="soapCallbackUrl"
                      type="url"
                      value={config.soapCallbackUrl ?? ""}
                      onChange={(e) =>
                        updateConfig("soapCallbackUrl", e.target.value)
                      }
                      placeholder="http://cp-host:8080/ocpp/soap/CP001"
                      required
                      className="logger-input"
                    />
                    <p className="text-xs text-muted mt-1">
                      OCPP 1.5 ChargePointService callback URL the Central
                      System uses to reach this CP. Required.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="soapPath" className="mb-2 logger-label">
                      SOAP Path (optional)
                    </Label>
                    <Input
                      id="soapPath"
                      type="text"
                      value={config.soapPath ?? ""}
                      onChange={(e) => updateConfig("soapPath", e.target.value)}
                      placeholder="/ocpp/soap"
                      className="logger-input"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Boot Notification */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Boot Notification</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label
                  htmlFor="chargePointVendor"
                  className="mb-2 logger-label"
                >
                  Vendor
                </Label>
                <Input
                  id="chargePointVendor"
                  type="text"
                  value={config.chargePointVendor}
                  onChange={(e) =>
                    updateConfig("chargePointVendor", e.target.value)
                  }
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="chargePointModel" className="mb-2 logger-label">
                  Model
                </Label>
                <Input
                  id="chargePointModel"
                  type="text"
                  value={config.chargePointModel}
                  onChange={(e) =>
                    updateConfig("chargePointModel", e.target.value)
                  }
                  className="logger-input"
                />
              </div>
              <div>
                <Label htmlFor="firmwareVersion" className="mb-2 logger-label">
                  Firmware Version
                </Label>
                <Input
                  id="firmwareVersion"
                  type="text"
                  value={config.firmwareVersion}
                  onChange={(e) =>
                    updateConfig("firmwareVersion", e.target.value)
                  }
                  className="logger-input"
                />
              </div>
            </div>
          </div>

          {mode === "remote" && (
            <div className="card p-4">
              <h3 className="card-header mb-4">Security</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="securityProfile" className="mb-2">
                    Security Profile
                  </Label>
                  <Select
                    value={String(securityProfile)}
                    onValueChange={(value) =>
                      updateConfig(
                        "securityProfile",
                        Number(value) as OcppSecurityProfile,
                      )
                    }
                  >
                    <SelectTrigger id="securityProfile">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0 — No auth, no TLS</SelectItem>
                      <SelectItem value="1">1 — Basic Auth</SelectItem>
                      <SelectItem value="2">
                        2 — Basic Auth + TLS (server cert)
                      </SelectItem>
                      <SelectItem value="3">
                        3 — Mutual TLS (client cert)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {securityProfile >= 1 && securityProfile <= 2 && (
                <div className="mt-4">
                  <Label
                    htmlFor="authorizationKey"
                    className="mb-2 logger-label"
                  >
                    Authorization Key
                  </Label>
                  <Input
                    id="authorizationKey"
                    type="password"
                    value={config.authorizationKey ?? ""}
                    onChange={(e) =>
                      updateConfig("authorizationKey", e.target.value)
                    }
                    placeholder={
                      isNewChargePoint ? "" : "Leave blank to keep current"
                    }
                    className="logger-input"
                  />
                </div>
              )}

              {securityProfile >= 2 && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <Label htmlFor="tlsCa" className="mb-2 logger-label">
                      CA Certificate PEM (optional)
                    </Label>
                    <Textarea
                      id="tlsCa"
                      value={config.tls?.ca ?? ""}
                      onChange={(e) => updateTls({ ca: e.target.value })}
                      placeholder={
                        isNewChargePoint ? "" : "Leave blank to keep current"
                      }
                      className="font-mono text-xs"
                      rows={4}
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="tlsServerName"
                      className="mb-2 logger-label"
                    >
                      Server Name (optional)
                    </Label>
                    <Input
                      id="tlsServerName"
                      type="text"
                      value={config.tls?.serverName ?? ""}
                      onChange={(e) =>
                        updateTls({ serverName: e.target.value })
                      }
                      className="logger-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-6">
                    <Checkbox
                      id="tlsRejectUnauthorized"
                      checked={config.tls?.rejectUnauthorized ?? true}
                      onCheckedChange={(checked) =>
                        updateTls({ rejectUnauthorized: checked as boolean })
                      }
                    />
                    <Label
                      htmlFor="tlsRejectUnauthorized"
                      className="logger-label"
                    >
                      Verify server certificate
                    </Label>
                  </div>
                </div>
              )}

              {securityProfile === 3 && (
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="tlsCert" className="mb-2 logger-label">
                      Client Certificate PEM
                    </Label>
                    <Textarea
                      id="tlsCert"
                      value={config.tls?.cert ?? ""}
                      onChange={(e) => updateTls({ cert: e.target.value })}
                      placeholder={
                        isNewChargePoint ? "" : "Leave blank to keep current"
                      }
                      className="font-mono text-xs"
                      rows={4}
                    />
                  </div>
                  <div>
                    <Label htmlFor="tlsKey" className="mb-2 logger-label">
                      Private Key PEM
                    </Label>
                    <Textarea
                      id="tlsKey"
                      value={config.tls?.key ?? ""}
                      onChange={(e) => updateTls({ key: e.target.value })}
                      placeholder={
                        isNewChargePoint ? "" : "Leave blank to keep current"
                      }
                      className="font-mono text-xs"
                      rows={4}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Optional Settings */}
          <div className="card p-4">
            <h3 className="card-header mb-4">Optional Settings</h3>

            {/* Basic Auth */}
            {mode === "local" || securityProfile === 0 ? (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-3">
                  <Checkbox
                    id="basicAuthEnabled"
                    checked={config.basicAuthEnabled}
                    onCheckedChange={(checked) =>
                      updateConfig("basicAuthEnabled", checked as boolean)
                    }
                  />
                  <Label htmlFor="basicAuthEnabled" className="logger-label">
                    Enable Basic Authentication
                  </Label>
                </div>
                {config.basicAuthEnabled && (
                  <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <Label
                        htmlFor="basicAuthUsername"
                        className="mb-2 logger-label"
                      >
                        Username
                      </Label>
                      <Input
                        id="basicAuthUsername"
                        type="text"
                        value={config.basicAuthUsername}
                        onChange={(e) =>
                          updateConfig("basicAuthUsername", e.target.value)
                        }
                        className="logger-input"
                      />
                    </div>
                    <div>
                      <Label
                        htmlFor="basicAuthPassword"
                        className="mb-2 logger-label"
                      >
                        Password
                      </Label>
                      <Input
                        id="basicAuthPassword"
                        type="password"
                        value={config.basicAuthPassword}
                        onChange={(e) =>
                          updateConfig("basicAuthPassword", e.target.value)
                        }
                        className="logger-input"
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted mb-4">
                Authentication is governed by the Authorization Key in the
                Security section above (security profile {securityProfile}).
              </p>
            )}

            {/* Auto Meter */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Checkbox
                  id="autoMeterValueEnabled"
                  checked={config.autoMeterValueEnabled}
                  onCheckedChange={(checked) =>
                    updateConfig("autoMeterValueEnabled", checked as boolean)
                  }
                />
                <Label htmlFor="autoMeterValueEnabled" className="logger-label">
                  Enable Auto Meter Value
                </Label>
              </div>
              {config.autoMeterValueEnabled && (
                <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label
                      htmlFor="autoMeterValueInterval"
                      className="mb-2 logger-label"
                    >
                      Interval (seconds)
                    </Label>
                    <Input
                      id="autoMeterValueInterval"
                      type="number"
                      min="1"
                      value={config.autoMeterValueInterval}
                      onChange={(e) =>
                        updateConfig(
                          "autoMeterValueInterval",
                          parseInt(e.target.value),
                        )
                      }
                      className="logger-input"
                    />
                  </div>
                  <div>
                    <Label
                      htmlFor="autoMeterValue"
                      className="mb-2 logger-label"
                    >
                      Increment Value (kWh)
                    </Label>
                    <Input
                      id="autoMeterValue"
                      type="number"
                      min="1"
                      value={config.autoMeterValue}
                      onChange={(e) =>
                        updateConfig("autoMeterValue", parseInt(e.target.value))
                      }
                      className="logger-input"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {saveError && (
          <p className="text-xs text-red-600 dark:text-red-400 px-1 mb-2">
            {saveError}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            <X className="mr-2 h-5 w-5" />
            Cancel
          </Button>
          <Button onClick={handleSave}>
            <Save className="mr-2 h-5 w-5" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ChargePointConfigModal;
