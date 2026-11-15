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
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { isSoapVersion } from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { FIELD_GRID_CLASS, Field, Section } from "./ChargePointConfigFormParts";
import type { ConfigFormState } from "./ChargePointConfigFormState";

export const SecuritySection: React.FC<{ form: ConfigFormState }> = ({
  form,
}) => {
  const { t } = useTranslation();
  const {
    config,
    mode,
    isNewChargePoint,
    updateConfig,
    changeSecurityProfile,
    updateTls,
    securityProfile,
  } = form;
  return (
    <>
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
    </>
  );
};
