import { useTranslation } from "react-i18next";
import React, { useState, useEffect, useMemo } from "react";
import { Save, X } from "lucide-react";
import { buildFullOcppUrl } from "../utils/ocppUrl";
import { BROWSER_TLS_UNSUPPORTED_MESSAGE } from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  adaptCentralSystemUrlScheme,
  adaptOcppUrlSecurity,
} from "../utils/ocppUrlScheme";
import {
  classifyBasicAuthSource,
  type OcppSecurityProfile,
  type OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import LabelsEditor from "./LabelsEditor";
import {
  defaultChargePointConfig,
  describeSoapPublicBase,
  labelMapFromRows,
  labelRowsFromMap,
  previewDerivedSoapCallbackUrl,
  sanitizeChargePointConfigForSave,
  versionForProtocol,
  type ChargePointConfig,
  type LabelRow,
  type OcppProtocol,
  type SoapPublicBase,
} from "./chargePointConfig";
import {
  ERROR_CLASS,
  FIELD_GRID_CLASS,
  Field,
  Section,
} from "./ChargePointConfigFormParts";
import {
  withoutDerivedSoapCallbackUrl,
  type ConfigFormState,
} from "./ChargePointConfigFormState";
import { ConnectionSection } from "./ChargePointConfigConnectionSection";
import { SecuritySection } from "./ChargePointConfigSecuritySection";
import { OptionalSection } from "./ChargePointConfigOptionalSection";

export interface ChargePointConfigFormProps {
  initialConfig?: ChargePointConfig;
  isNewChargePoint?: boolean;
  /**
   * Active runtime mode. Currently used only to label and disable a few
   * fields that don't have a remote equivalent yet (e.g. the local tag list).
   */
  mode?: "local" | "remote";
  /**
   * `server.info`'s `soap` block: the public base the daemon derives a
   * missing callback URL from (`--soap-public-base-url` / `--soap-tunnel`).
   * With one, the callback URL becomes optional here and the derived value
   * is previewed. null when unknown (local mode, older daemon).
   */
  soapPublicBase?: SoapPublicBase | null;
  /** Called with the sanitized config once validation passes. */
  onSave: (config: ChargePointConfig) => void;
  onCancel: () => void;
  /** Label of the save button; "Save" by default. */
  submitLabel?: string;
}

/**
 * The charge point's settings as a form: the body of the Add / Configure
 * dialog (`ChargePointConfigModal`) and the inline Config card of the charge
 * point page. State, validation and the error line live here; the wrapper only
 * decides where it is drawn and what Save and Cancel do afterwards.
 */
const ChargePointConfigForm: React.FC<ChargePointConfigFormProps> = ({
  initialConfig,
  isNewChargePoint = false,
  mode = "local",
  soapPublicBase = null,
  onSave,
  onCancel,
  submitLabel,
}) => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ChargePointConfig>(
    withoutDerivedSoapCallbackUrl(initialConfig || defaultChargePointConfig),
  );

  // #446: the labels editor's rows, possibly incomplete while typed. null
  // until the operator touches them when the labels are not known
  // (`initialConfig.labels` undefined), so Save leaves them out.
  const [labelRows, setLabelRows] = useState<LabelRow[] | null>(
    initialConfig?.labels ? labelRowsFromMap(initialConfig.labels) : null,
  );

  useEffect(() => {
    if (initialConfig) {
      setConfig(withoutDerivedSoapCallbackUrl(initialConfig));
      setLabelRows(
        initialConfig.labels ? labelRowsFromMap(initialConfig.labels) : null,
      );
    }
  }, [initialConfig]);

  const derivedSoapCallbackUrl = previewDerivedSoapCallbackUrl(
    mode === "remote" ? soapPublicBase : null,
    config.cpId,
    config.soapPath,
  );
  // Local mode has no callback endpoint at all; remote mode can leave the
  // field to the daemon once it has a public base to derive from.
  const soapCallbackOptional =
    mode === "local" || derivedSoapCallbackUrl != null;
  const soapCallbackHelp =
    mode === "local"
      ? t("settings.form.soapHelpLocal")
      : derivedSoapCallbackUrl
        ? t("settings.form.soapHelpDerived", {
            source: describeSoapPublicBase(soapPublicBase),
            url: derivedSoapCallbackUrl,
          })
        : t("settings.form.soapHelpRequired");

  const handleSave = () => {
    const profile = config.securityProfile ?? 0;
    const hasTlsMaterial = Boolean(
      config.tls?.ca || config.tls?.cert || config.tls?.key,
    );
    if (
      mode === "local" &&
      (profile === 2 || profile === 3 || hasTlsMaterial)
    ) {
      setSaveError(BROWSER_TLS_UNSUPPORTED_MESSAGE);
      return;
    }
    if (
      !soapCallbackOptional &&
      isSoapVersion(config.ocppVersion) &&
      !config.soapCallbackUrl?.trim()
    ) {
      setSaveError(t("settings.form.errSoapCallbackRequired"));
      return;
    }
    if (
      mode === "remote" &&
      profile === 3 &&
      isNewChargePoint &&
      !(config.tls?.cert?.trim() && config.tls?.key?.trim())
    ) {
      setSaveError(t("settings.form.errProfile3Cert"));
      return;
    }
    // #471: only the Add form edits labels; an update never sends them
    // (useCpConfigActions), the page header relabels in place instead.
    let labels = config.labels;
    if (mode === "remote" && isNewChargePoint && labelRows) {
      const parsed = labelMapFromRows(labelRows);
      if ("error" in parsed) {
        setSaveError(parsed.error);
        return;
      }
      labels = parsed.labels;
    }
    setSaveError(null);
    // Closing is the caller's call: the inline form stays open when the save
    // fails, the dialog closes right away (ChargePointConfigModal).
    onSave(sanitizeChargePointConfigForSave({ ...config, labels }));
  };

  const updateConfig = (
    key: keyof ChargePointConfig,
    value: ChargePointConfig[keyof ChargePointConfig],
  ) => {
    setConfig({ ...config, [key]: value });
  };

  // Switching the protocol keeps the version number when the other protocol
  // has it (1.6 JSON <-> 1.6 SOAP), else takes that protocol's first version;
  // either way through changeOcppVersion, so the URL scheme follows.
  const changeProtocol = (value: string) => {
    changeOcppVersion(
      versionForProtocol(config.ocppVersion, value as OcppProtocol),
    );
  };

  // Changing the OCPP version also flips the Central System URL scheme to match
  // the new transport (SOAP = http(s), JSON = ws(s)), but only when the current
  // scheme is incompatible — a custom compatible URL is preserved (#164).
  const changeOcppVersion = (value: string) => {
    setConfig((prev) => ({
      ...prev,
      ocppVersion: value,
      wsURL: adaptCentralSystemUrlScheme(prev.wsURL, isSoapVersion(value)),
    }));
  };

  // #178 item G / #277: OCPP 1.6 security profiles only ever *upgrade* the
  // transport at connect time (profiles 2/3 → wss), so mirror that into the
  // displayed URL scheme when the profile changes rather than letting the form
  // silently diverge from the wire. Profile 1 says nothing about the transport
  // (A00.FR.206 even recommends an independently secured channel) and profile
  // 0 enforces nothing, so both leave the operator's typed scheme untouched.
  const changeSecurityProfile = (value: string) => {
    const profile = Number(value) as OcppSecurityProfile;
    setConfig((prev) =>
      profile >= 2
        ? {
            ...prev,
            securityProfile: profile,
            wsURL: adaptOcppUrlSecurity(prev.wsURL, true),
          }
        : { ...prev, securityProfile: profile },
    );
  };

  const updateTls = (patch: Partial<OcppTlsOptions>) => {
    setConfig((prev) => ({ ...prev, tls: { ...prev.tls, ...patch } }));
  };

  // The Effective WebSocket URL display: wsURL + basic auth, composed.
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const securityProfile = config.securityProfile ?? 0;
  // #178 item F: what actually governs Basic Auth right now, per the same
  // classifier the connection layer uses (wsUrlWithBasic.ts). Drives the
  // Optional Settings pointer text below the Security section.
  const basicAuthSource = classifyBasicAuthSource({
    securityProfile: config.securityProfile,
    legacyBasicAuthEnabled: config.basicAuthEnabled,
  });

  // The SOAP callback / TLS material save-blocking errors above are only
  // valid for the config that was on screen when Save was clicked. Once the
  // operator changes the field that made them invalid (switches away from
  // OCPP-1.5, fills in the callback URL, or edits the security
  // profile/cert/key), clear the stale message instead of leaving it
  // rendered until the next Save click recomputes it.
  useEffect(() => {
    setSaveError(null);
  }, [
    config.ocppVersion,
    config.soapCallbackUrl,
    config.securityProfile,
    config.tls?.cert,
    config.tls?.key,
    labelRows,
  ]);

  // What the CSMS will be told to call: the typed value, else what the
  // daemon derives from its public base, else the one it already derived for
  // this charge point (the form blanks a derived URL; see above).
  const typedSoapCallbackUrl = config.soapCallbackUrl?.trim();
  const effectiveSoapCallbackUrl =
    typedSoapCallbackUrl ||
    derivedSoapCallbackUrl ||
    (initialConfig?.soapCallbackUrlDerived
      ? initialConfig.soapCallbackUrl
      : undefined) ||
    null;

  const form: ConfigFormState = {
    config,
    mode,
    isNewChargePoint,
    soapPublicBase,
    derivedSoapCallbackUrl,
    soapCallbackOptional,
    soapCallbackHelp,
    updateConfig,
    changeProtocol,
    changeOcppVersion,
    changeSecurityProfile,
    updateTls,
    composedFullUrl,
    typedSoapCallbackUrl,
    effectiveSoapCallbackUrl,
    securityProfile,
    basicAuthSource,
  };

  return (
    <div className="space-y-5">
      <Section title={t("settings.form.section.model")}>
        <div className={FIELD_GRID_CLASS}>
          <Field id="chargePointVendor" label={t("settings.form.vendor")}>
            <Input
              id="chargePointVendor"
              type="text"
              value={config.chargePointVendor}
              onChange={(e) =>
                updateConfig("chargePointVendor", e.target.value)
              }
            />
          </Field>
          <Field id="chargePointModel" label={t("settings.form.model")}>
            <Input
              id="chargePointModel"
              type="text"
              value={config.chargePointModel}
              onChange={(e) => updateConfig("chargePointModel", e.target.value)}
            />
          </Field>
          <Field
            id="firmwareVersion"
            label={t("settings.form.firmwareVersion")}
          >
            <Input
              id="firmwareVersion"
              type="text"
              value={config.firmwareVersion}
              onChange={(e) => updateConfig("firmwareVersion", e.target.value)}
            />
          </Field>
          <Field id="connectorNumber" label={t("settings.form.connectorCount")}>
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
            />
          </Field>
        </div>
      </Section>

      <ConnectionSection form={form} />

      <SecuritySection form={form} />

      {mode === "remote" && isNewChargePoint && (
        <Section title={t("settings.form.section.labels")}>
          <LabelsEditor rows={labelRows ?? []} onChange={setLabelRows} />
        </Section>
      )}

      <OptionalSection form={form} />

      {saveError && (
        <p role="alert" className={ERROR_CLASS}>
          {saveError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          <X className="h-4 w-4" />
          {t("settings.common.cancel")}
        </Button>
        <Button type="button" onClick={handleSave}>
          <Save className="h-4 w-4" />
          {submitLabel ?? t("settings.common.save")}
        </Button>
      </div>
    </div>
  );
};

export default ChargePointConfigForm;
