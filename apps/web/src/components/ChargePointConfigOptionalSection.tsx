import { useTranslation } from "react-i18next";
import React from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  isOcpp2Version,
  isSoapVersion,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import {
  FIELD_GRID_CLASS,
  Field,
  HINT_CLASS,
  Section,
} from "./ChargePointConfigFormParts";
import type { ConfigFormState } from "./ChargePointConfigFormState";

import { Button } from "@/components/ui/button";
export const OptionalSection: React.FC<{ form: ConfigFormState }> = ({
  form,
}) => {
  const { t } = useTranslation();
  const { config, mode, updateConfig, securityProfile, basicAuthSource } = form;
  return (
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
              <Field id="basicAuthUsername" label={t("settings.form.username")}>
                <Input
                  id="basicAuthUsername"
                  type="text"
                  value={config.basicAuthUsername}
                  onChange={(e) =>
                    updateConfig("basicAuthUsername", e.target.value)
                  }
                />
              </Field>
              <Field id="basicAuthPassword" label={t("settings.form.password")}>
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
        <p className={cn(HINT_CLASS, "mb-4")}>{t("settings.form.authMtls")}</p>
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
          <p className={cn(HINT_CLASS, "mb-4")}>{t("settings.form.noAuth")}</p>
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
              checked={config.txUpdatedMeterValues !== false}
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
            <Field id="autoMeterValue" label={t("settings.form.incrementKwh")}>
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
  );
};
