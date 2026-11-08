import React, { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDataContext } from "@/data/providers/DataProvider";
import type { OcppCallOutcome } from "@ocpp-cp-sim/core/cp/domain/types/OcppCall";
import {
  getOcppCallCatalog,
  type OcppCallCatalog,
} from "@ocpp-cp-sim/core/cp/infrastructure/transport/codec/ocppCallCatalog";
import EmptyState from "../../components/EmptyState";
import { useT, type MessageKey } from "../../../i18n";

export interface ExpertCallPanelProps {
  cpId: string;
  /** The CP's OCPP version; undefined while it is not known yet. */
  ocppVersion: string | undefined;
  connected: boolean;
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** The payload text as an object, or why it cannot be sent at all. */
function parsePayload(
  text: string,
): { payload: Record<string, unknown> } | { problemKey: MessageKey } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problemKey: "cpPanels.expert.notJson" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problemKey: "cpPanels.expert.notObject" };
  }
  return { payload: parsed as Record<string, unknown> };
}

/**
 * Expert OCPP call panel (#389): pick a station-initiated action of the CP's
 * OCPP-J version, edit its payload (pre-filled with the smallest valid one),
 * send it, and read the frame sent and the CSMS's CALLRESULT / CALLERROR.
 * The schema check runs as you type; a schema-invalid payload goes out only
 * with the explicit skip ticked. Uses `chargePointService.sendOcppCall`, the
 * same API the control plane and the `ocppCall` scenario node use.
 */
const ExpertCallPanel: React.FC<ExpertCallPanelProps> = ({
  cpId,
  ocppVersion,
  connected,
}) => {
  const t = useT();
  const catalog = ocppVersion ? getOcppCallCatalog(ocppVersion) : null;
  if (!ocppVersion) {
    return (
      <EmptyState
        title={t("cpPanels.expert.versionUnknown")}
        hint={t("cpPanels.expert.versionUnknownHint")}
      />
    );
  }
  if (!catalog) {
    return (
      <EmptyState
        title={t("cpPanels.expert.soapTitle")}
        hint={t("cpPanels.expert.soapHint", { version: ocppVersion })}
      />
    );
  }
  // Keyed by version: the form's action, payload and last answer belong to
  // one version's catalog, so a version change starts the form over.
  return (
    <ExpertCallForm
      key={ocppVersion}
      cpId={cpId}
      ocppVersion={ocppVersion}
      catalog={catalog}
      connected={connected}
    />
  );
};

const ExpertCallForm: React.FC<{
  cpId: string;
  ocppVersion: string;
  catalog: OcppCallCatalog;
  connected: boolean;
}> = ({ cpId, ocppVersion, catalog, connected }) => {
  const t = useT();
  const { chargePointService } = useDataContext();
  // Every OCPP-J version has it (ocppCallCatalog.test.ts), and it needs no
  // payload.
  const firstAction = "Heartbeat";
  const [action, setAction] = useState(firstAction);
  const [payloadText, setPayloadText] = useState(() =>
    pretty(catalog.defaultPayload(firstAction)),
  );
  const [skipValidation, setSkipValidation] = useState(false);
  const [applyResponse, setApplyResponse] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [outcome, setOutcome] = useState<OcppCallOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const parsed = useMemo(() => parsePayload(payloadText), [payloadText]);
  const schemaWarning = useMemo(
    () =>
      "payload" in parsed ? catalog.validate(action, parsed.payload) : null,
    [catalog, action, parsed],
  );

  const canSend =
    connected &&
    !isPending &&
    "payload" in parsed &&
    (schemaWarning === null || skipValidation);

  const loadDefault = (next: string) => {
    setAction(next);
    setPayloadText(pretty(catalog.defaultPayload(next)));
  };

  const handleSend = async () => {
    if (!canSend || !("payload" in parsed)) return;
    setIsPending(true);
    setOutcome(null);
    setFailure(null);
    try {
      setOutcome(
        await chargePointService.sendOcppCall(cpId, {
          action,
          payload: parsed.payload,
          skipValidation,
          applyResponse,
        }),
      );
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPending(false);
    }
  };

  const problem = "problemKey" in parsed ? t(parsed.problemKey) : schemaWarning;

  return (
    <div className="space-y-4 rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-6 text-sm">
      <p className="text-cx-fg2">
        {t("cpPanels.expert.intro", { version: ocppVersion })}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-cx-fg2">
            {t("cpPanels.expert.action")}
          </span>
          <select
            aria-label={t("cpPanels.expert.action")}
            value={action}
            onChange={(e) => loadDefault(e.target.value)}
            className="rounded-md border border-cx-border-strong px-2 py-1 text-sm text-cx-fg"
          >
            {catalog.actions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => loadDefault(action)}
        >
          {t("cpPanels.expert.resetDefault")}
        </Button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-cx-fg2">
          {t("cpPanels.expert.payloadJson")}
        </span>
        <Textarea
          aria-label={t("cpPanels.expert.payloadAria")}
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          rows={12}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </label>

      {problem && (
        <p role="alert" className="whitespace-pre-wrap text-xs text-cx-amber">
          {problem}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="skipValidation"
            checked={skipValidation}
            onChange={(e) => setSkipValidation(e.target.checked)}
          />
          <span>{t("cpPanels.expert.skipValidation")}</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="applyResponse"
            checked={applyResponse}
            onChange={(e) => setApplyResponse(e.target.checked)}
          />
          <span>{t("cpPanels.expert.applyResponse")}</span>
        </label>
      </div>

      <Button type="button" disabled={!canSend} onClick={handleSend}>
        {t("cpPanels.expert.send")}
      </Button>
      {!connected && (
        <p className="text-xs text-cx-muted">
          {t("cpPanels.expert.connectFirst")}
        </p>
      )}

      {failure && (
        <p role="alert" className="text-xs text-cx-rose">
          {failure}
        </p>
      )}

      {outcome && (
        <section aria-label={t("cpPanels.expert.result")} className="space-y-2">
          <div>
            <div className="text-xs font-semibold text-cx-fg2">
              {t("cpPanels.expert.sentFrame")}
            </div>
            <pre className="whitespace-pre-wrap break-all rounded bg-cx-sub p-2 font-mono text-xs">
              {outcome.sentFrame}
            </pre>
          </div>
          <div>
            <div className="text-xs font-semibold text-cx-fg2">
              {outcome.kind === "callResult"
                ? "CALLRESULT"
                : `CALLERROR ${outcome.errorCode}`}
            </div>
            <pre className="overflow-x-auto rounded bg-cx-sub p-2 font-mono text-xs">
              {outcome.kind === "callResult"
                ? pretty(outcome.payload)
                : [outcome.errorDescription, pretty(outcome.errorDetails)]
                    .filter(Boolean)
                    .join("\n")}
            </pre>
          </div>
        </section>
      )}
    </div>
  );
};

export default ExpertCallPanel;
