/**
 * A Repeat block's bounds (schema 1.10 loop edges) as the Steps and Graph
 * views show them: the summary line with the `until` cases as chips, and
 * the inline editor (the bounds form of `components/scenario/forms`).
 */
import React from "react";
import { useTranslation } from "react-i18next";

import LoopBoundsForm from "../../../../components/scenario/forms/LoopBoundsForm";
import {
  type Capability,
  type LoopBlock,
  type LoopBoundsInput,
  loopBlockBounds,
} from "../../../lib/blockTree";
import {
  loopBoundsInput,
  loopSummary,
  loopSummaryText,
} from "../../../lib/stepTree";

/** Splits a translated template around `{{name}}` filled with a marker, so a
 *  React node can stand there. */
const MARK = "\u0001";
function around(text: string): [string, string] {
  const at = text.indexOf(MARK);
  return at === -1 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
}

/** "Repeat 3 times / for 2 h / until <value> is <case chips> (whichever
 *  first)"; "Repeat forever" without bounds. The full text is the title. */
export const LoopBoundsSummary: React.FC<{
  loop: Pick<LoopBlock, "loopEdge">;
  className?: string;
}> = ({ loop, className }) => {
  const { t } = useTranslation();
  const summary = loopSummary(loop);
  const title = loopSummaryText(loop);
  if (summary.kind !== "bounded") {
    return (
      <span data-testid="loop-summary" title={title} className={className}>
        {title}
      </span>
    );
  }
  const pieces: React.ReactNode[] = summary.parts.map((part) => (
    <span key={part}>{part}</span>
  ));
  if (summary.until) {
    const [before, after] = around(
      t("scenarioRun.loopBounds.until", {
        value: summary.until.value,
        cases: MARK,
      }),
    );
    const or = t("scenarioRun.loopBounds.casesOr");
    pieces.push(
      <span key="until">
        {before}
        {summary.until.cases.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && or}
            <code
              data-testid="loop-until-chip"
              className="rounded bg-cx-purple/15 px-1 font-mono text-[11px] text-cx-fg2"
            >
              {c}
            </code>
          </React.Fragment>
        ))}
        {after}
      </span>,
    );
  }
  const separator = t("scenarioRun.loopBounds.separator");
  const [pre, post] = around(
    t("scenarioRun.loopBounds.repeat", { bounds: MARK }),
  );
  return (
    <span data-testid="loop-summary" title={title} className={className}>
      {pre}
      {pieces.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && separator}
          {p}
        </React.Fragment>
      ))}
      {post}
      {summary.several && ` ${t("scenarioRun.loopBounds.whicheverFirst")}`}
    </span>
  );
};

/** What the views need to edit a loop's bounds. */
export interface LoopBoundsEditing {
  canSet: (headerId: string, bounds: LoopBoundsInput) => Capability;
  onSet: (headerId: string, bounds: LoopBoundsInput) => void;
  stateKeys?: readonly string[];
}

/** The inline editor of a loop's bounds: the form, every change written at
 *  once; a change the editor refuses is disabled with its reason. */
export const LoopBoundsPanel: React.FC<{
  loop: Pick<LoopBlock, "headerId" | "loopEdge">;
  editing: LoopBoundsEditing;
  onClose: () => void;
}> = ({ loop, editing, onClose }) => {
  const { t } = useTranslation();
  const bounds = loopBlockBounds(loop);
  return (
    <div
      data-testid="loop-bounds-panel"
      data-loop={loop.headerId}
      className="space-y-2 rounded-[10px] border border-cx-border bg-cx-card p-3 text-left font-normal shadow-sm"
    >
      {bounds !== null && "problem" in bounds && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("scenarioRun.loopBounds.invalid", { problem: bounds.problem })}
        </p>
      )}
      <LoopBoundsForm
        value={loopBoundsInput(loop)}
        stateKeys={editing.stateKeys}
        refusal={(next) => {
          const cap = editing.canSet(loop.headerId, next);
          return cap.ok ? undefined : t(cap.reason);
        }}
        onChange={(next) => {
          if (editing.canSet(loop.headerId, next).ok) {
            editing.onSet(loop.headerId, next);
          }
        }}
      />
      <div className="flex justify-end">
        <button
          type="button"
          data-testid="loop-bounds-done"
          onClick={onClose}
          className="btn-secondary px-2 py-1 text-xs"
        >
          {t("scenarioRun.loopBounds.done")}
        </button>
      </div>
    </div>
  );
};
