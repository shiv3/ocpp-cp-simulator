import { useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useDataContext } from "@/data/providers/DataProvider";
import type { ConfigurationKeyInfo } from "@ocpp-cp-sim/core/cp/domain/charge-point/configurationAccess";

import EmptyState from "../../components/EmptyState";

export interface ConfigurationKeysTabProps {
  cpId: string;
}

type Feedback =
  | { kind: "ok"; status: "Accepted" | "RebootRequired" }
  | { kind: "error"; message: string };

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * A charge point's OCPP configuration keys (#612): read with
 * `cp.config_keys.get`, written with `cp.config_keys.set`. A read-only key has
 * no editor; a refusal from the charge point (read-only, value outside the
 * key's type or bounds) is shown against its row. Version-independent: a 2.x
 * station also shows the Device Model name and mutability of each key.
 */
const ConfigurationKeysTab: React.FC<ConfigurationKeysTabProps> = ({
  cpId,
}) => {
  const { t } = useTranslation();
  const { chargePointService } = useDataContext();
  const supported =
    typeof chargePointService.getConfigurationKeys === "function" &&
    typeof chargePointService.setConfigurationKey === "function";

  const [keys, setKeys] = useState<readonly ConfigurationKeyInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  const load = useCallback(async () => {
    if (!supported) return;
    try {
      const list = await chargePointService.getConfigurationKeys!(cpId);
      setKeys(list.keys);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [chargePointService, cpId, supported]);

  useEffect(() => {
    setDrafts({});
    setFeedback({});
    void load();
  }, [load]);

  const save = async (key: string) => {
    const value = drafts[key];
    if (value === undefined) return;
    try {
      const status = await chargePointService.setConfigurationKey!(
        cpId,
        key,
        value,
      );
      setFeedback((f) => ({ ...f, [key]: { kind: "ok", status } }));
      setDrafts(({ [key]: _saved, ...rest }) => rest);
      await load();
    } catch (err) {
      setFeedback((f) => ({
        ...f,
        [key]: { kind: "error", message: errorText(err) },
      }));
    }
  };

  if (!supported) {
    return <EmptyState title={t("cp.configKeys.unsupported")} />;
  }
  if (loadError) {
    return (
      <EmptyState title={t("cp.configKeys.loadFailed")} hint={loadError} />
    );
  }
  if (keys.length === 0) {
    return <EmptyState title={t("cp.configKeys.empty")} />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-cx-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-cx-sub text-xs uppercase tracking-wide text-cx-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{t("cp.configKeys.key")}</th>
            <th className="px-3 py-2 font-medium">
              {t("cp.configKeys.value")}
            </th>
            <th className="px-3 py-2 font-medium">
              {t("cp.configKeys.access")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-cx-border">
          {keys.map((info) => {
            const draft = drafts[info.key];
            const note = feedback[info.key];
            const writeOnly = info.mutability === "WriteOnly";
            return (
              <tr key={info.key} data-testid="config-key-row">
                <td className="px-3 py-2 font-mono text-xs text-cx-fg2">
                  {info.key}
                  {info.component && (
                    <div className="text-cx-muted">
                      {info.component}.{info.variable}
                      {info.instance ? `[${info.instance}]` : ""}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {info.readonly ? (
                    <span className="font-mono text-xs text-cx-fg2">
                      {info.value}
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        aria-label={t("cp.configKeys.valueOf", {
                          key: info.key,
                        })}
                        className="w-64 rounded-md border border-cx-border bg-cx-card px-2 py-1 font-mono text-xs"
                        value={draft ?? info.value}
                        placeholder={
                          writeOnly ? t("cp.configKeys.writeOnly") : undefined
                        }
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [info.key]: e.target.value,
                          }))
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        // An empty draft of an integer key would be stored as 0.
                        disabled={
                          draft === undefined ||
                          (info.type === "integer" && draft.trim() === "")
                        }
                        onClick={() => void save(info.key)}
                      >
                        {t("cp.configKeys.save")}
                      </Button>
                    </div>
                  )}
                  {note?.kind === "ok" && (
                    <div className="mt-1 text-xs text-cx-emerald" role="status">
                      {note.status === "RebootRequired"
                        ? t("cp.configKeys.rebootRequired")
                        : t("cp.configKeys.saved")}
                    </div>
                  )}
                  {note?.kind === "error" && (
                    <div className="mt-1 text-xs text-cx-rose" role="alert">
                      {note.message}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-cx-fg2">
                  {info.readonly
                    ? t("cp.configKeys.readOnly")
                    : t("cp.configKeys.readWrite")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default ConfigurationKeysTab;
