import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ALL_CHARGE_POINT_ERROR_CODES,
  OCPPStatus,
} from "@/cp/domain/types/OcppTypes";
import type { HeartbeatView } from "@/data/hooks/useChargePointView";
import { useGlobalTagIds } from "@/data/hooks/useGlobalTagIds";
import { useDataContext } from "@/data/providers/DataProvider";

import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import { formatRelativeTime } from "../../lib/formatRelativeTime";
import { useNow } from "../../lib/useNow";

/** The statuses connector 0 (the charge point itself) may report. */
const CP_STATUSES = [
  OCPPStatus.Available,
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
] as const;

const SELECT_CLASS = cn(FILTER_SELECT_CLASS, "text-xs disabled:opacity-60");

export interface ChargePointControlsProps {
  cpId: string;
  connected: boolean;
  heartbeat: HeartbeatView;
}

/**
 * Charge-point-level calls of the classic charge point card: Heartbeat (with
 * the interval and the last one sent), Authorize, and a StatusNotification
 * for connector 0 — with an error code when Faulted (§7.6).
 */
const ChargePointControls: React.FC<ChargePointControlsProps> = ({
  cpId,
  connected,
  heartbeat,
}) => {
  const { chargePointService } = useDataContext();
  const { tagIds } = useGlobalTagIds();
  // Re-render so "last sent" stays current between heartbeats.
  useNow();
  const [tagIdInput, setTagIdInput] = useState("");
  const [status, setStatus] = useState<OCPPStatus>(OCPPStatus.Available);
  const [errorCode, setErrorCode] = useState("InternalError");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tagId = tagIds.includes(tagIdInput) ? tagIdInput : (tagIds[0] ?? "");

  const run = async (label: string, call: () => Promise<void>) => {
    setIsPending(true);
    setError(null);
    try {
      await call();
    } catch (err) {
      console.error(`${label} failed on ${cpId}`, err);
      setError(
        `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsPending(false);
    }
  };

  const sendStatus = () =>
    run("StatusNotification", () =>
      status === OCPPStatus.Faulted
        ? chargePointService.sendStatusNotification(cpId, 0, status, {
            errorCode,
          })
        : chargePointService.sendStatusNotification(cpId, 0, status),
    );

  const disabled = !connected || isPending;

  return (
    <div
      data-testid="charge-point-controls"
      className="mb-4 rounded-[10px] border border-cx-border bg-cx-card px-4 py-2.5"
    >
      {/* One compact row: the label, then the three calls. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        <span className="text-sm font-semibold text-cx-fg">
          Charge point
          <span className="ml-1 font-normal text-cx-muted">(connector 0)</span>
        </span>
        <div className="flex items-center gap-2">
          <span
            className="text-cx-fg2"
            title="Set by BootNotification.conf and ChangeConfiguration HeartbeatInterval (§4.6)"
          >
            {heartbeat.intervalSeconds > 0
              ? `Heartbeat every ${heartbeat.intervalSeconds} s`
              : "Heartbeat not configured"}
            {` · last sent ${formatRelativeTime(heartbeat.lastSentAt)}`}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void run("Heartbeat", () =>
                chargePointService.sendHeartbeat(cpId),
              )
            }
          >
            Send Heartbeat
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="TagID to authorize"
            value={tagId}
            onChange={(e) => setTagIdInput(e.target.value)}
            disabled={tagIds.length === 0}
            className={SELECT_CLASS}
          >
            {tagIds.length === 0 ? (
              <option value="">No TagIDs configured</option>
            ) : (
              tagIds.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))
            )}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !tagId}
            onClick={() =>
              void run("Authorize", () =>
                chargePointService.authorize(cpId, tagId),
              )
            }
          >
            Authorize
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <select
            aria-label="Charge point status"
            value={status}
            onChange={(e) => setStatus(e.target.value as OCPPStatus)}
            className={SELECT_CLASS}
          >
            {CP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Error code"
            value={errorCode}
            onChange={(e) => setErrorCode(e.target.value)}
            disabled={status !== OCPPStatus.Faulted}
            title="errorCode sent with Faulted"
            className={SELECT_CLASS}
          >
            {ALL_CHARGE_POINT_ERROR_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void sendStatus()}
          >
            Send status
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-cx-rose">
          {error}
        </p>
      )}
    </div>
  );
};

export default ChargePointControls;
