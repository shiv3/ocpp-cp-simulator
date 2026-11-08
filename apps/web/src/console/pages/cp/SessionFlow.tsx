import React, { useState } from "react";

import { cn } from "@/lib/utils";
import { OCPPStatus } from "@ocpp-cp-sim/core/cp/domain/types/OcppTypes";

import { FILTER_SELECT_CLASS } from "../../components/filterStyles";
import { useT, type MessageKey } from "../../../i18n";

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
type StepState = "done" | "next" | "alt" | "current" | "todo";

const STEPS: ReadonlyArray<{ id: StepId; labelKey: MessageKey }> = [
  { id: "plugin", labelKey: "cpPanels.flow.plugIn" },
  { id: "start", labelKey: "cpPanels.flow.start" },
  { id: "stop", labelKey: "cpPanels.flow.stop" },
  { id: "unplug", labelKey: "cpPanels.flow.unplug" },
];

/**
 * Where the session stands: the step to take next. A transaction means
 * charging (Stop next) until Finishing; without one, a plugged connector
 * (Preparing, or a charging status a scenario sent) waits for Start,
 * Finishing for Unplug, anything else for Plug in.
 */
function nextStep(status: OCPPStatus, transactionId: number | null): StepId {
  if (status === OCPPStatus.Finishing) return "unplug";
  if (transactionId != null) return "stop";
  switch (status) {
    case OCPPStatus.Preparing:
    case OCPPStatus.Charging:
    case OCPPStatus.SuspendedEV:
    case OCPPStatus.SuspendedEVSE:
      return "start";
    default:
      return "plugin";
  }
}

/**
 * Later steps that can be taken instead of the next one: a plugged connector
 * can be unplugged without charging (Preparing → Available).
 */
const ALTERNATIVES: Partial<Record<StepId, ReadonlyArray<StepId>>> = {
  start: ["unplug"],
};

/**
 * The charging session as a stepper (`Plug in → Start charging → Stop
 * charging → Unplug`): done steps carry a check, the next step is the primary
 * button, an alternative to it (Unplug before charging) is a secondary
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
  const t = useT();
  const [tagInput, setTagInput] = useState("");
  const tagId = tagIds.includes(tagInput) ? tagInput : (tagIds[0] ?? "");

  const unavailable = status === OCPPStatus.Unavailable;
  const faulted = status === OCPPStatus.Faulted;
  const next = nextStep(status, transactionId);
  const nextIndex = STEPS.findIndex((s) => s.id === next);

  const stateOf = (id: StepId, index: number): StepState => {
    if (unavailable) return "todo";
    if (id === next) return faulted ? "current" : "next";
    if (index < nextIndex) return "done";
    if (!faulted && ALTERNATIVES[next]?.includes(id)) return "alt";
    return "todo";
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
      aria-label={t("cpPanels.flow.group")}
      className="mt-3.5 flex flex-wrap items-center gap-y-1 rounded-[9px] bg-cx-sub px-2.5 py-2 @max-[520px]:px-1"
    >
      {STEPS.map((step, index) => {
        const state = stateOf(step.id, index);
        const label =
          state === "current" && transactionId != null && step.id === "stop"
            ? t("cpPanels.flow.chargingFaulted")
            : t(step.labelKey);
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
              disabled={
                (state !== "next" && state !== "alt") || pending || blocked
              }
              onClick={actions[step.id]}
              className={cn(
                "inline-flex items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[9px] py-[5px] text-[12.5px] font-medium @max-[520px]:gap-1.5 @max-[520px]:px-1.5 @max-[520px]:text-xs",
                state === "todo" && "text-cx-faint",
                state === "done" && "text-cx-muted",
                state === "current" && "text-cx-fg",
                state === "alt" &&
                  "text-cx-fg shadow-[inset_0_0_0_1px_var(--cx-border-strong)] hover:bg-cx-card disabled:opacity-60",
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

      {!unavailable && !faulted && next === "start" && (
        <label className="ml-auto inline-flex items-center gap-1.5 pl-2 text-xs text-cx-muted @max-[520px]:basis-full @max-[520px]:pl-0 @max-[520px]:pt-1">
          {t("cpPanels.flow.withTag")}
          <select
            value={tagId}
            onChange={(e) => setTagInput(e.target.value)}
            disabled={tagIds.length === 0 || pending}
            className={cn(
              FILTER_SELECT_CLASS,
              "h-7 min-w-[120px] disabled:opacity-60",
            )}
            title={t("cpPanels.flow.tagTitle")}
            aria-label={t("cpPanels.flow.tagAria")}
          >
            {tagIds.length === 0 ? (
              <option value="">{t("cpPanels.flow.noTagIds")}</option>
            ) : (
              tagIds.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))
            )}
          </select>
        </label>
      )}
      {!unavailable && transactionId != null && next === "stop" && (
        <span className="ml-auto pl-2 font-mono text-xs text-cx-muted @max-[520px]:basis-full @max-[520px]:pl-0 @max-[520px]:pt-1">
          {t("cpPanels.flow.tx", { id: transactionId })}
          {transactionTagId ? ` · ${transactionTagId}` : ""}
        </span>
      )}
      {unavailable && (
        <span className="ml-auto pl-2 text-xs text-cx-muted @max-[520px]:basis-full @max-[520px]:pl-0 @max-[520px]:pt-1">
          {t("cpPanels.flow.unavailable")}
        </span>
      )}
    </div>
  );
};

export default SessionFlow;
