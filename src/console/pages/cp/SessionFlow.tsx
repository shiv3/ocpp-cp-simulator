import React, { useState } from "react";

import { cn } from "@/lib/utils";
import { OCPPStatus } from "@/cp/domain/types/OcppTypes";

import { FILTER_SELECT_CLASS } from "../../components/filterStyles";

export interface SessionFlowProps {
  status: OCPPStatus;
  transactionId: number | null;
  transactionTagId: string | null;
  /** The TagIDs from Settings, for Start charging. */
  tagIds: string[];
  /** A step's call is in flight: the stepper waits for it. */
  pending: boolean;
  onPlugIn: () => void;
  onStart: (tagId: string) => void;
  onStop: () => void;
  onUnplug: () => void;
}

type StepId = "plugin" | "start" | "stop" | "unplug";
type StepState = "done" | "next" | "current" | "todo";

const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: "plugin", label: "Plug in" },
  { id: "start", label: "Start charging" },
  { id: "stop", label: "Stop charging" },
  { id: "unplug", label: "Unplug" },
];

/**
 * Where the session stands: the index of the step to take next. A
 * transaction means charging (Stop next) until Finishing; without one, a
 * plugged connector (Preparing, or a charging status a scenario sent) waits
 * for Start, Finishing for Unplug, anything else for Plug in.
 */
function sessionPosition(
  status: OCPPStatus,
  transactionId: number | null,
): number {
  if (status === OCPPStatus.Finishing) return 3;
  if (transactionId != null) return 2;
  switch (status) {
    case OCPPStatus.Preparing:
    case OCPPStatus.Charging:
    case OCPPStatus.SuspendedEV:
    case OCPPStatus.SuspendedEVSE:
      return 1;
    default:
      return 0;
  }
}

/**
 * The charging session as a stepper (`Plug in → Start charging → Stop
 * charging → Unplug`): done steps carry a check, the next step is the primary
 * button, later steps are faint. Faulted shows where the session stopped with
 * nothing to press; Unavailable disables every step and says how to get out.
 */
const SessionFlow: React.FC<SessionFlowProps> = ({
  status,
  transactionId,
  transactionTagId,
  tagIds,
  pending,
  onPlugIn,
  onStart,
  onStop,
  onUnplug,
}) => {
  const [tagInput, setTagInput] = useState("");
  const tagId = tagIds.includes(tagInput) ? tagInput : (tagIds[0] ?? "");

  const unavailable = status === OCPPStatus.Unavailable;
  const faulted = status === OCPPStatus.Faulted;
  const position = sessionPosition(status, transactionId);

  const stateOf = (index: number): StepState => {
    if (unavailable) return "todo";
    if (index < position) return "done";
    if (index > position) return "todo";
    return faulted ? "current" : "next";
  };

  const actions: Record<StepId, () => void> = {
    plugin: onPlugIn,
    start: () => {
      if (tagId) onStart(tagId);
    },
    stop: onStop,
    unplug: onUnplug,
  };

  return (
    <div
      role="group"
      aria-label="Charging session"
      className="mt-3.5 flex flex-wrap items-center gap-y-1 rounded-[9px] bg-cx-sub px-2.5 py-2 @max-[520px]:px-1"
    >
      {STEPS.map((step, index) => {
        const state = stateOf(index);
        const label =
          state === "current" && transactionId != null && index === 2
            ? "Charging (faulted)"
            : step.label;
        const blocked = step.id === "start" && !tagId;
        return (
          <React.Fragment key={step.id}>
            {index > 0 && (
              <span
                aria-hidden
                className="h-[1.5px] w-[18px] flex-none bg-cx-border-strong @max-[520px]:w-1.5"
              />
            )}
            <button
              type="button"
              data-step={step.id}
              data-state={state}
              disabled={state !== "next" || pending || blocked}
              onClick={actions[step.id]}
              className={cn(
                "inline-flex items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[9px] py-[5px] text-[12.5px] font-medium @max-[520px]:gap-1.5 @max-[520px]:px-1.5 @max-[520px]:text-xs",
                state === "todo" && "text-cx-faint",
                state === "done" && "text-cx-muted",
                state === "current" && "text-cx-fg",
                state === "next" &&
                  "bg-cx-primary text-white hover:bg-cx-primary-hover disabled:opacity-60",
              )}
            >
              <i
                aria-hidden
                className={cn(
                  "inline-grid h-3.5 w-3.5 place-items-center @max-[520px]:h-3 @max-[520px]:w-3 rounded-full border-[1.5px] border-cx-border-strong bg-cx-card text-[9px] not-italic leading-none text-cx-faint",
                  state === "done" &&
                    "border-cx-emerald bg-cx-emerald text-white",
                  state === "current" &&
                    "border-cx-accent text-cx-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--cx-accent)_22%,transparent)]",
                  state === "next" && "border-white bg-white text-cx-primary",
                )}
              >
                {state === "done" ? "✓" : state === "next" ? "▶" : ""}
              </i>
              {label}
            </button>
          </React.Fragment>
        );
      })}

      {!unavailable && !faulted && position === 1 && (
        <label className="ml-auto inline-flex items-center gap-1.5 pl-2 text-xs text-cx-muted @max-[520px]:basis-full @max-[520px]:pl-0 @max-[520px]:pt-1">
          with tag
          <select
            value={tagId}
            onChange={(e) => setTagInput(e.target.value)}
            disabled={tagIds.length === 0 || pending}
            className={cn(
              FILTER_SELECT_CLASS,
              "h-7 min-w-[120px] disabled:opacity-60",
            )}
            title="RFID tag to authorize the transaction with"
            aria-label="TagID of the transaction"
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
        </label>
      )}
      {!unavailable && transactionId != null && position === 2 && (
        <span className="ml-auto pl-2 font-mono text-xs text-cx-muted @max-[520px]:basis-full @max-[520px]:pl-0 @max-[520px]:pt-1">
          Tx #{transactionId}
          {transactionTagId ? ` · ${transactionTagId}` : ""}
        </span>
      )}
      {unavailable && (
        <span className="ml-auto pl-2 text-xs text-cx-muted @max-[520px]:basis-full @max-[520px]:pl-0 @max-[520px]:pt-1">
          Unavailable: send Available in Controls to plug in
        </span>
      )}
    </div>
  );
};

export default SessionFlow;
