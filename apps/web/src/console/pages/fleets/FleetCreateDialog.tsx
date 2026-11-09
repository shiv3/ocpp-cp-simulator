import { useTranslation } from "react-i18next";
import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
  FleetCreateParams,
  FleetCreateResult,
  FleetTemplate,
} from "@ocpp-cp-simulator/contracts/methods";
import Switch from "../../components/Switch";
import { templateCpCount } from "../../lib/fleetTemplates";

export interface FleetCreateDialogProps {
  template: FleetTemplate;
  onCreate: (params: FleetCreateParams) => Promise<FleetCreateResult>;
  onClose: () => void;
}

/**
 * Creates a fleet from a template (`fleet.create`). Partial success is a normal
 * result: the dialog then lists what was created and, for each charge point
 * that was not, the reason, in the template's order.
 */
const FleetCreateDialog: React.FC<FleetCreateDialogProps> = ({
  template,
  onCreate,
  onClose,
}) => {
  const { t } = useTranslation();
  const [wsUrl, setWsUrl] = useState("");
  const [idPrefix, setIdPrefix] = useState("");
  const [autoConnect, setAutoConnect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FleetCreateResult | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const params: FleetCreateParams = {
        templateId: template.id,
        ...(wsUrl.trim() ? { wsUrl: wsUrl.trim() } : {}),
        ...(idPrefix ? { idPrefix } : {}),
        ...(autoConnect ? { autoConnect: true } : {}),
      };
      setResult(await onCreate(params));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="w-[min(560px,calc(100vw-32px))] max-w-none gap-3 border-cx-border-strong bg-cx-card text-cx-fg sm:rounded-xl">
        <DialogTitle className="text-[15px] font-semibold tracking-normal">
          {t("fleets.create.title", { name: template.name })}
        </DialogTitle>
        <DialogDescription className="text-[12.5px] text-cx-muted">
          {t("fleets.create.hint", { count: templateCpCount(template) })}
        </DialogDescription>
        {result === null ? (
          <>
            <label className="block text-[12.5px]">
              <span className="mb-1 block font-medium">
                {t("fleets.create.wsUrl")}
              </span>
              <Input
                value={wsUrl}
                placeholder="ws://csms.example/ocpp"
                onChange={(event) => setWsUrl(event.target.value)}
              />
              <span className="mt-1 block text-cx-muted">
                {t("fleets.create.wsUrlHint")}
              </span>
            </label>
            <label className="block text-[12.5px]">
              <span className="mb-1 block font-medium">
                {t("fleets.create.idPrefix")}
              </span>
              <Input
                value={idPrefix}
                onChange={(event) => setIdPrefix(event.target.value)}
              />
              <span className="mt-1 block text-cx-muted">
                {t("fleets.create.idPrefixHint")}
              </span>
            </label>
            <Switch
              label={t("fleets.create.autoConnect")}
              checked={autoConnect}
              onChange={setAutoConnect}
            >
              {t("fleets.create.autoConnect")}
            </Switch>
            {error && (
              <div
                role="alert"
                className="rounded-md border border-cx-rose/40 bg-cx-rose/10 px-3 py-2 text-[12.5px]"
              >
                {error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={onClose}>
                {t("fleets.create.cancel")}
              </Button>
              <Button disabled={busy} onClick={() => void submit()}>
                {busy ? t("fleets.create.creating") : t("fleets.create.submit")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div role="status" className="space-y-2 text-[13px]">
              <p>
                {t("fleets.create.created", { count: result.created.length })}
              </p>
              {result.created.length > 0 && (
                <p className="font-mono text-[12px] text-cx-muted">
                  {result.created.join(", ")}
                </p>
              )}
              {result.failed.length > 0 && (
                <div role="alert" className="space-y-1">
                  <p className="font-semibold">
                    {t("fleets.create.failed", {
                      count: result.failed.length,
                    })}
                  </p>
                  <ul className="list-disc space-y-0.5 pl-5 text-[12.5px]">
                    {result.failed.map((failure) => (
                      <li key={failure.cpId}>
                        <span className="font-mono">{failure.cpId}</span>:{" "}
                        {failure.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button onClick={onClose}>{t("fleets.create.close")}</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default FleetCreateDialog;
