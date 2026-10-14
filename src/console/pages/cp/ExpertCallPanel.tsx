import React, { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDataContext } from "@/data/providers/DataProvider";
import type { OcppCallOutcome } from "@/cp/domain/types/OcppCall";
import {
  getOcppCallCatalog,
  type OcppCallCatalog,
} from "@/cp/infrastructure/transport/codec/ocppCallCatalog";
import EmptyState from "../../components/EmptyState";

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
): { payload: Record<string, unknown> } | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "Payload is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: "Payload must be a JSON object" };
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
  const catalog = ocppVersion ? getOcppCallCatalog(ocppVersion) : null;
  if (!ocppVersion) {
    return (
      <EmptyState
        title="OCPP version unknown"
        hint="Expert calls need the charge point's OCPP version."
      />
    );
  }
  if (!catalog) {
    return (
      <EmptyState
        title="Expert OCPP calls are not available over SOAP"
        hint={`${ocppVersion} builds each SOAP envelope per operation; only OCPP-J stations (1.6J, 2.0.1, 2.1) can send an arbitrary call.`}
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

  const problem = "problem" in parsed ? parsed.problem : schemaWarning;

  return (
    <div className="space-y-4 rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-6 text-sm">
      <p className="text-cx-fg2">
        Send any station-initiated {ocppVersion} call through the normal
        connection. The answer is logged and shown below; it changes the
        station's state only when you ask for it.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-cx-fg2">Action</span>
          <select
            aria-label="Action"
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
          Reset to default
        </Button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-cx-fg2">
          Payload (JSON)
        </span>
        <Textarea
          aria-label="Payload"
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
          <span>
            Skip schema validation — send a schema-invalid payload on purpose
            (this call only)
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="applyResponse"
            checked={applyResponse}
            onChange={(e) => setApplyResponse(e.target.checked)}
          />
          <span>Apply the answer to the station's state</span>
        </label>
      </div>

      <Button type="button" disabled={!canSend} onClick={handleSend}>
        Send
      </Button>
      {!connected && (
        <p className="text-xs text-cx-muted">
          Connect the charge point to send a call.
        </p>
      )}

      {failure && (
        <p role="alert" className="text-xs text-cx-rose">
          {failure}
        </p>
      )}

      {outcome && (
        <section aria-label="Result" className="space-y-2">
          <div>
            <div className="text-xs font-semibold text-cx-fg2">Sent frame</div>
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
