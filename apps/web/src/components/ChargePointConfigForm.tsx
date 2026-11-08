import { useTranslation } from "react-i18next";
import React, { useState, useEffect, useMemo, useRef } from "react";
import { Save, X } from "lucide-react";
import { buildFullOcppUrl } from "../utils/ocppUrl";
import { BROWSER_TLS_UNSUPPORTED_MESSAGE } from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import {
  isOcpp2Version,
  isSoapVersion,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  adaptCentralSystemUrlScheme,
  adaptOcppUrlSecurity,
} from "../utils/ocppUrlScheme";
import {
  classifyBasicAuthSource,
  type OcppSecurityProfile,
  type OcppTlsOptions,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/wsUrlWithBasic";
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
import { cn } from "@/lib/utils";
import LabelsEditor from "./LabelsEditor";
import {
  OCPP_PROTOCOLS,
  defaultChargePointConfig,
  describeSoapPublicBase,
  labelMapFromRows,
  labelRowsFromMap,
  protocolOf,
  previewDerivedSoapCallbackUrl,
  sanitizeChargePointConfigForSave,
  versionForProtocol,
  versionsOfProtocol,
  type ChargePointConfig,
  type LabelRow,
  type OcppProtocol,
  type SoapPublicBase,
} from "./chargePointConfig";

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

// The small uppercase label over each field, like the console's key figures.
// `dark:` twin because the shared Label sets its own dark colour.
const LABEL_CLASS =
  "mb-1.5 block text-[11px] font-normal uppercase leading-none tracking-[0.06em] text-cx-faint dark:text-cx-faint";
// Fields flow into as many 160px+ columns as the container fits, so the same
// form works in the 520px side panel, on the page and in the dialog.
const FIELD_GRID_CLASS =
  "grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3";
const HINT_CLASS = "mt-1 text-xs text-cx-muted";
const ERROR_CLASS = "mt-1 text-xs text-cx-rose";

const Field: React.FC<{
  id: string;
  label: React.ReactNode;
  /** Takes the whole row (URLs, PEM blocks). */
  wide?: boolean;
  children: React.ReactNode;
}> = ({ id, label, wide, children }) => (
  <div className={cn("min-w-0", wide && "col-span-full")}>
    <Label htmlFor={id} className={LABEL_CLASS}>
      {label}
    </Label>
    {children}
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section>
    <h3 className="mb-2 text-[13px] font-semibold text-cx-fg">{title}</h3>
    {children}
  </section>
);

/**
 * The SOAP callback URL is the one value the operator has to carry over to
 * the CSMS by hand, so the effective one gets a copy button. When the daemon
 * derived it from a tunnel, say so: a free-tier ngrok URL changes between
 * runs, and the CSMS entry has to follow it.
 */
const SoapCallbackUrlRow: React.FC<{
  url: string;
  /** Where a derived URL came from; null for an explicit one. */
  note: string | null;
}> = ({ url, note }) => {
  const { t } = useTranslation();
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
  return (
    <div className="col-span-full">
      <span className={LABEL_CLASS}>
        {t("settings.form.effectiveCallbackUrl")}
      </span>
      <div className="flex items-start gap-2">
        <span className="break-all font-mono text-[13px] text-cx-fg">
          {url}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={t("settings.form.copySoapCallbackAria")}
        >
          {copyState === "copied"
            ? t("settings.common.copied")
            : copyState === "failed"
              ? t("settings.form.copyFailed")
              : t("settings.common.copy")}
        </Button>
      </div>
      {note && <p className={HINT_CLASS}>{note}</p>}
    </div>
  );
};

/**
 * The URL the charge point will dial, composed from the WebSocket URL and the
 * Basic Auth settings: a display, never an input, so the value has one place
 * to be edited. Copy puts it on the clipboard; without the clipboard API
 * (plain-http origins other than localhost) the button does nothing.
 */
const EffectiveWsUrlRow: React.FC<{ url: string }> = ({ url }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      console.error("Failed to copy the effective WebSocket URL", error);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Field id="effectiveWsURL" label={t("settings.form.effectiveWsUrl")} wide>
      <div className="flex items-center gap-2">
        <Input
          id="effectiveWsURL"
          type="text"
          readOnly
          value={url}
          className="font-mono"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={t("settings.form.copyWsAria")}
        >
          {copied ? t("settings.common.copied") : t("settings.common.copy")}
        </Button>
      </div>
      <p className={HINT_CLASS}>{t("settings.form.effectiveWsUrlHint")}</p>
    </Field>
  );
};

/**
 * A derived callback URL belongs to the daemon's current base, not to the
 * charge point: editing it as a value would send it back explicit and freeze
 * one run's tunnel origin into the row. The form keeps the field empty and
 * shows the derivation as its placeholder instead.
 */
function withoutDerivedSoapCallbackUrl(
  config: ChargePointConfig,
): ChargePointConfig {
  return config.soapCallbackUrlDerived
    ? { ...config, soapCallbackUrl: "" }
    : config;
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

      <Section title={t("settings.form.section.connection")}>
        <div className={FIELD_GRID_CLASS}>
          <Field id="cpId" label={t("settings.form.cpId")}>
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
              className="font-mono"
            />
          </Field>
          <Field id="ocppProtocol" label={t("settings.form.protocol")}>
            <Select
              value={protocolOf(config.ocppVersion)}
              onValueChange={changeProtocol}
            >
              <SelectTrigger id="ocppProtocol">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OCPP_PROTOCOLS.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="ocppVersion" label={t("settings.form.version")}>
            <Select
              value={config.ocppVersion}
              onValueChange={changeOcppVersion}
            >
              <SelectTrigger id="ocppVersion">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versionsOfProtocol(protocolOf(config.ocppVersion)).map(
                  (option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id="wsURL"
            label={
              isSoapVersion(config.ocppVersion)
                ? t("settings.form.centralSystemUrlSoap")
                : t("settings.form.wsUrl")
            }
            wide
          >
            <Input
              id="wsURL"
              type="url"
              value={config.wsURL}
              onChange={(e) => updateConfig("wsURL", e.target.value)}
              required
              className="font-mono"
            />
          </Field>
          {!isSoapVersion(config.ocppVersion) && (
            <EffectiveWsUrlRow url={composedFullUrl} />
          )}
          {isSoapVersion(config.ocppVersion) && (
            <>
              {mode === "local" && (
                <div className="col-span-full rounded-[7px] border border-cx-border bg-cx-sub p-3 text-xs text-cx-fg2">
                  <strong>{t("settings.form.localSoapNoteTitle")}</strong>{" "}
                  {t("settings.form.localSoapNoteBody")}
                </div>
              )}
              <Field
                id="soapCallbackUrl"
                wide
                label={
                  <>
                    {t("settings.form.soapCallbackUrl")}
                    {soapCallbackOptional && (
                      <span className="ml-1 normal-case tracking-normal">
                        {t("settings.form.optionalParen")}
                      </span>
                    )}
                  </>
                }
              >
                <Input
                  id="soapCallbackUrl"
                  type="url"
                  value={config.soapCallbackUrl ?? ""}
                  onChange={(e) =>
                    updateConfig("soapCallbackUrl", e.target.value)
                  }
                  placeholder={
                    derivedSoapCallbackUrl ??
                    "http://cp-host:8080/ocpp/soap/CP001"
                  }
                  required={!soapCallbackOptional}
                  className="font-mono"
                />
                <p className={HINT_CLASS}>{soapCallbackHelp}</p>
              </Field>
              <Field id="soapPath" label={t("settings.form.soapPath")}>
                <Input
                  id="soapPath"
                  type="text"
                  value={config.soapPath ?? ""}
                  onChange={(e) => updateConfig("soapPath", e.target.value)}
                  placeholder="/ocpp/soap"
                  className="font-mono"
                />
              </Field>
              {mode === "remote" && effectiveSoapCallbackUrl && (
                <SoapCallbackUrlRow
                  url={effectiveSoapCallbackUrl}
                  note={
                    typedSoapCallbackUrl
                      ? null
                      : t("settings.form.derivedNote", {
                          source: describeSoapPublicBase(soapPublicBase),
                        })
                  }
                />
              )}
            </>
          )}
        </div>
      </Section>

      {mode === "remote" && !isSoapVersion(config.ocppVersion) && (
        <Section title={t("settings.form.section.security")}>
          <div className={FIELD_GRID_CLASS}>
            <Field
              id="securityProfile"
              label={t("settings.form.securityProfile")}
            >
              <Select
                value={String(securityProfile)}
                onValueChange={changeSecurityProfile}
              >
                <SelectTrigger id="securityProfile">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">
                    {t("settings.form.profile0")}
                  </SelectItem>
                  <SelectItem value="1">
                    {t("settings.form.profile1")}
                  </SelectItem>
                  <SelectItem value="2">
                    {t("settings.form.profile2")}
                  </SelectItem>
                  <SelectItem value="3">
                    {t("settings.form.profile3")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {securityProfile >= 1 && securityProfile <= 2 && (
              <Field
                id="authorizationKey"
                label={t("settings.form.authorizationKey")}
              >
                <Input
                  id="authorizationKey"
                  type="password"
                  value={config.authorizationKey ?? ""}
                  onChange={(e) =>
                    updateConfig("authorizationKey", e.target.value)
                  }
                  placeholder={
                    isNewChargePoint ? "" : t("settings.common.keepCurrent")
                  }
                />
              </Field>
            )}
            {securityProfile >= 2 && (
              <>
                <Field id="tlsCa" label={t("settings.form.caCert")} wide>
                  <Textarea
                    id="tlsCa"
                    value={config.tls?.ca ?? ""}
                    onChange={(e) => updateTls({ ca: e.target.value })}
                    placeholder={
                      isNewChargePoint ? "" : t("settings.common.keepCurrent")
                    }
                    className="font-mono text-xs"
                    rows={4}
                  />
                </Field>
                <Field id="tlsServerName" label={t("settings.form.serverName")}>
                  <Input
                    id="tlsServerName"
                    type="text"
                    value={config.tls?.serverName ?? ""}
                    onChange={(e) => updateTls({ serverName: e.target.value })}
                  />
                </Field>
                <div className="flex items-center gap-2 self-end pb-2">
                  <Checkbox
                    id="tlsRejectUnauthorized"
                    checked={config.tls?.rejectUnauthorized ?? true}
                    onCheckedChange={(checked) =>
                      updateTls({ rejectUnauthorized: checked as boolean })
                    }
                  />
                  <Label
                    htmlFor="tlsRejectUnauthorized"
                    className="text-[13px] font-normal text-cx-fg2 dark:text-cx-fg2"
                  >
                    {t("settings.form.verifyServerCert")}
                  </Label>
                </div>
              </>
            )}
            {securityProfile === 3 && (
              <>
                <Field id="tlsCert" label={t("settings.form.clientCert")}>
                  <Textarea
                    id="tlsCert"
                    value={config.tls?.cert ?? ""}
                    onChange={(e) => updateTls({ cert: e.target.value })}
                    placeholder={
                      isNewChargePoint ? "" : t("settings.common.keepCurrent")
                    }
                    className="font-mono text-xs"
                    rows={4}
                  />
                </Field>
                <Field id="tlsKey" label={t("settings.form.privateKey")}>
                  <Textarea
                    id="tlsKey"
                    value={config.tls?.key ?? ""}
                    onChange={(e) => updateTls({ key: e.target.value })}
                    placeholder={
                      isNewChargePoint ? "" : t("settings.common.keepCurrent")
                    }
                    className="font-mono text-xs"
                    rows={4}
                  />
                </Field>
              </>
            )}
          </div>
        </Section>
      )}

      {mode === "remote" && isNewChargePoint && (
        <Section title={t("settings.form.section.labels")}>
          <LabelsEditor rows={labelRows ?? []} onChange={setLabelRows} />
        </Section>
      )}

      <Section title={t("settings.form.section.optional")}>
        {/* Basic Auth — #178 item F: the Security section above (1.6+,
            remote mode) is the single source of truth for Basic Auth.
            This generic toggle is the fallback path retained for
            configurations that have no Security Profile concept: local
            mode (no per-CP TLS/profile plumbing) and SOAP versions
            (OCPP 1.2 / 1.5 / 1.6S — the WS-based security-profile model
            doesn't apply to the SOAP transport). See
            classifyBasicAuthSource in wsUrlWithBasic.ts for the
            single-resolver precedence both this UI and the connection
            layer share. */}
        {mode === "local" || isSoapVersion(config.ocppVersion) ? (
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="basicAuthEnabled"
                checked={config.basicAuthEnabled}
                onCheckedChange={(checked) =>
                  updateConfig("basicAuthEnabled", checked as boolean)
                }
              />
              <Label
                htmlFor="basicAuthEnabled"
                className="text-[13px] font-normal text-cx-fg2 dark:text-cx-fg2"
              >
                {t("settings.form.enableBasicAuth")}
              </Label>
            </div>
            {config.basicAuthEnabled && (
              <div className={cn(FIELD_GRID_CLASS, "mt-3")}>
                <Field
                  id="basicAuthUsername"
                  label={t("settings.form.username")}
                >
                  <Input
                    id="basicAuthUsername"
                    type="text"
                    value={config.basicAuthUsername}
                    onChange={(e) =>
                      updateConfig("basicAuthUsername", e.target.value)
                    }
                  />
                </Field>
                <Field
                  id="basicAuthPassword"
                  label={t("settings.form.password")}
                >
                  <Input
                    id="basicAuthPassword"
                    type="password"
                    value={config.basicAuthPassword}
                    onChange={(e) =>
                      updateConfig("basicAuthPassword", e.target.value)
                    }
                  />
                </Field>
              </div>
            )}
          </div>
        ) : securityProfile === 3 ? (
          <p className={cn(HINT_CLASS, "mb-4")}>
            {t("settings.form.authMtls")}
          </p>
        ) : securityProfile === 0 ? (
          basicAuthSource === "legacy" ? (
            <div className="mb-4">
              <p className="mb-2 text-xs text-cx-muted">
                {t("settings.form.legacyBefore")}{" "}
                <code>
                  {config.basicAuthUsername || t("settings.form.legacyNone")}
                </code>
                {t("settings.form.legacyAfter")}
              </p>
              {/* #178 item F: legacy Basic Auth has no editable control in
                  the Security section, so without this a remote+non-SOAP CP
                  that already had it enabled could never turn it off from
                  the UI. Mirrors the Optional Settings checkbox's off path
                  (basicAuthEnabled → false). */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateConfig("basicAuthEnabled", false)}
              >
                {t("settings.form.disableLegacyBasic")}
              </Button>
            </div>
          ) : (
            <p className={cn(HINT_CLASS, "mb-4")}>
              {t("settings.form.noAuth")}
            </p>
          )
        ) : (
          <p className={cn(HINT_CLASS, "mb-4")}>
            {t("settings.form.authKeyGoverned", {
              profile: securityProfile,
            })}
          </p>
        )}

        {/* #550: OCPP 2.x only; 1.x ignores the option. */}
        {isOcpp2Version(config.ocppVersion) && (
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <Checkbox
                id="txUpdatedMeterValues"
                checked={config.txUpdatedMeterValues === true}
                onCheckedChange={(checked) =>
                  updateConfig("txUpdatedMeterValues", checked === true)
                }
              />
              <Label
                htmlFor="txUpdatedMeterValues"
                className="text-[13px] font-normal text-cx-fg2 dark:text-cx-fg2"
              >
                {t("settings.form.txUpdatedMeterValues")}
              </Label>
            </div>
            <p className={HINT_CLASS}>
              {t("settings.form.txUpdatedMeterValuesHint")}
            </p>
          </div>
        )}
        {/* Auto Meter */}
        <div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="autoMeterValueEnabled"
              checked={config.autoMeterValueEnabled}
              onCheckedChange={(checked) =>
                updateConfig("autoMeterValueEnabled", checked as boolean)
              }
            />
            <Label
              htmlFor="autoMeterValueEnabled"
              className="text-[13px] font-normal text-cx-fg2 dark:text-cx-fg2"
            >
              {t("settings.form.enableAutoMeter")}
            </Label>
          </div>
          {config.autoMeterValueEnabled && (
            <div className={cn(FIELD_GRID_CLASS, "mt-3")}>
              <Field
                id="autoMeterValueInterval"
                label={t("settings.form.intervalSeconds")}
              >
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
                />
              </Field>
              <Field
                id="autoMeterValue"
                label={t("settings.form.incrementKwh")}
              >
                <Input
                  id="autoMeterValue"
                  type="number"
                  min="1"
                  value={config.autoMeterValue}
                  onChange={(e) =>
                    updateConfig("autoMeterValue", parseInt(e.target.value))
                  }
                />
              </Field>
            </div>
          )}
        </div>
      </Section>

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
