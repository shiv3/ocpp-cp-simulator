import { useTranslation } from "react-i18next";
import React from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  OCPP_PROTOCOLS,
  protocolOf,
  versionsOfProtocol,
} from "./chargePointConfig";
import {
  FIELD_GRID_CLASS,
  Field,
  HINT_CLASS,
  Section,
  EffectiveWsUrlRow,
  SoapCallbackUrlRow,
} from "./ChargePointConfigFormParts";
import { describeSoapPublicBase } from "./chargePointConfig";
import type { ConfigFormState } from "./ChargePointConfigFormState";

export const ConnectionSection: React.FC<{ form: ConfigFormState }> = ({
  form,
}) => {
  const { t } = useTranslation();
  const {
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
    composedFullUrl,
    effectiveSoapCallbackUrl,
    typedSoapCallbackUrl,
  } = form;
  return (
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
          <Select value={config.ocppVersion} onValueChange={changeOcppVersion}>
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
  );
};
