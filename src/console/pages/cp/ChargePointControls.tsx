import React, { useId, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

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
import { Group, Hint, Row } from "./controlPrimitives";
import Figure from "./Figure";

/** The statuses connector 0 (the charge point itself) may report. */
const CP_STATUSES = [
  OCPPStatus.Available,
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
] as const;

const SELECT_CLASS = cn(FILTER_SELECT_CLASS, "min-w-0 flex-1 text-xs");

type GroupId = "heartbeat" | "authorize" | "status";

export interface ChargePointControlsProps {
  cpId: string;
  connected: boolean;
  heartbeat: HeartbeatView;
}

/**
 * Charge-point-level calls of the classic charge point card, in the
 * connector card's shape: a header with the Heartbeat figure (interval, time
 * to the next one, a bar between heartbeats), Send Heartbeat and a Controls
 * toggle; behind the toggle the Heartbeat, Authorize and Status and faults
 * groups (StatusNotification for connector 0, with an error code when
 * Faulted, §7.6). Each group reports its own failure.
 */
const ChargePointControls: React.FC<ChargePointControlsProps> = ({
  cpId,
  connected,
  heartbeat,
}) => {
  const { chargePointService } = useDataContext();
  const { tagIds } = useGlobalTagIds();
  // Re-render every second: the countdown and the bar follow the clock.
  const now = useNow(1_000);
  const controlsId = useId();
  const [open, setOpen] = useState(false);
  const [tagIdInput, setTagIdInput] = useState("");
  const [status, setStatus] = useState<OCPPStatus>(OCPPStatus.Available);
  const [errorCode, setErrorCode] = useState("InternalError");
  const [isPending, setIsPending] = useState(false);
  const [errors, setErrors] = useState<Record<GroupId, string | null>>({
    heartbeat: null,
    authorize: null,
    status: null,
  });

  const tagId = tagIds.includes(tagIdInput) ? tagIdInput : (tagIds[0] ?? "");

  const run = async (
    group: GroupId,
    label: string,
    call: () => Promise<void>,
  ) => {
    setIsPending(true);
    setErrors((prev) => ({ ...prev, [group]: null }));
    try {
      await call();
    } catch (err) {
      console.error(`${label} failed on ${cpId}`, err);
      setErrors((prev) => ({
        ...prev,
        [group]: `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setIsPending(false);
    }
  };

  const sendHeartbeat = () =>
    run("heartbeat", "Heartbeat", () => chargePointService.sendHeartbeat(cpId));

  const sendStatus = () =>
    run("status", "StatusNotification", () =>
      status === OCPPStatus.Faulted
        ? chargePointService.sendStatusNotification(cpId, 0, status, {
            errorCode,
          })
        : chargePointService.sendStatusNotification(cpId, 0, status),
    );

  const disabled = !connected || isPending;

  const { intervalSeconds, lastSentAt } = heartbeat;
  const configured = intervalSeconds > 0;
  const elapsed =
    lastSentAt == null ? null : (now - lastSentAt.getTime()) / 1000;
  const lastSent =
    lastSentAt == null
      ? "not sent yet"
      : `last sent ${formatRelativeTime(lastSentAt)}`;
  let note: string;
  if (!configured) note = "not configured";
  else if (!connected || elapsed == null) note = lastSent;
  else note = `next in ${Math.max(0, Math.ceil(intervalSeconds - elapsed))}s`;
  const pct =
    configured && elapsed != null ? (elapsed / intervalSeconds) * 100 : 0;

  return (
    <section
      data-testid="charge-point-controls"
      aria-label="Charge point"
      className="mb-4 rounded-[10px] border border-cx-border bg-cx-card px-[18px] py-4"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <b className="text-[15px] font-semibold text-cx-fg">Charge point</b>
          <span className="text-[12.5px] text-cx-muted">connector 0</span>
        </div>
        <dl
          className="m-0 min-w-[180px]"
          title="Set by BootNotification.conf and ChangeConfiguration HeartbeatInterval (§4.6)"
        >
          <Figure
            label="Heartbeat"
            value={configured ? `${intervalSeconds} s` : "—"}
            note={note}
            bar={
              configured
                ? {
                    // One decimal, so the width is stable between renders.
                    pct: Number(Math.min(100, Math.max(0, pct)).toFixed(1)),
                    className: connected ? "bg-cx-accent" : "bg-cx-fg2",
                  }
                : undefined
            }
          />
        </dl>
        <span className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void sendHeartbeat()}
          >
            Send Heartbeat
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-controls={controlsId}
            onClick={() => setOpen((v) => !v)}
            className={cn(open && "bg-cx-sub text-cx-fg")}
          >
            Controls
            {open ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </span>
      </div>
      {/* A failed header Send Heartbeat must not hide in the folded block. */}
      {!open && errors.heartbeat && (
        <p role="alert" className="mt-2 text-xs text-cx-rose">
          {errors.heartbeat}
        </p>
      )}

      <div
        id={controlsId}
        hidden={!open}
        className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-2.5"
      >
        <Group title="Heartbeat" error={open ? errors.heartbeat : null}>
          <Hint>
            {configured ? `every ${intervalSeconds} s` : "not configured"} ·{" "}
            {lastSent}
          </Hint>
          <Row>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => void sendHeartbeat()}
            >
              Send Heartbeat
            </Button>
          </Row>
        </Group>

        <Group title="Authorize" error={errors.authorize}>
          <Row>
            <select
              aria-label="TagID to authorize"
              value={tagId}
              onChange={(e) => setTagIdInput(e.target.value)}
              disabled={tagIds.length === 0}
              className={cn(SELECT_CLASS, "disabled:opacity-60")}
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
                void run("authorize", "Authorize", () =>
                  chargePointService.authorize(cpId, tagId),
                )
              }
            >
              Authorize
            </Button>
          </Row>
          {tagIds.length === 0 && <Hint>Tag IDs come from Settings</Hint>}
        </Group>

        <Group title="Status and faults" error={errors.status}>
          <Row>
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
              className={cn(SELECT_CLASS, "disabled:opacity-60")}
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
          </Row>
          <Hint>
            StatusNotification for connector 0 · errorCode only with Faulted
          </Hint>
        </Group>
      </div>
    </section>
  );
};

export default ChargePointControls;
