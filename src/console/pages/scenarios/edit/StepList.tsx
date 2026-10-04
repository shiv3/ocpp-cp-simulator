import React, { useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../../../components/scenario/forms/nodeFormRegistry";
import { stepSummary } from "../../../lib/scenarioSteps";
import type {
  ScenarioNode,
  ScenarioNodeType,
} from "../../../../cp/application/scenario/ScenarioTypes";
import AddStepPicker from "./AddStepPicker";

export interface StepListProps {
  /** Ordered steps, START/END already excluded (see `deriveLinearSteps`). */
  steps: ScenarioNode[];
  selectedStepId: string | null;
  onSelect: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onInsert: (index: number, type: ScenarioNodeType) => void;
}

const InsertSlot: React.FC<{ onPick: (type: ScenarioNodeType) => void }> = ({
  onPick,
}) => {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div className="py-1">
        <AddStepPicker
          onPick={(type) => {
            onPick(type);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="group/insert flex h-2 items-center justify-center">
      <button
        type="button"
        aria-label="Insert step here"
        onClick={() => setOpen(true)}
        className="flex h-4 w-full items-center justify-center rounded text-cx-faint opacity-0 hover:bg-cx-sel hover:text-cx-accent focus-visible:opacity-100 group-hover/insert:opacity-100"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
};

/**
 * Numbered, ordered step list — the left column of the linear scenario
 * editor. No drag-and-drop library: reordering is via ↑/↓ icon buttons per
 * the brief.
 */
const StepList: React.FC<StepListProps> = ({
  steps,
  selectedStepId,
  onSelect,
  onDelete,
  onMove,
  onInsert,
}) => {
  const [showAddAtEnd, setShowAddAtEnd] = useState(false);

  return (
    <div className="space-y-0.5">
      <InsertSlot onPick={(type) => onInsert(0, type)} />
      {steps.map((step, index) => {
        const entry = isScenarioNodeType(step.type)
          ? NODE_FORM_REGISTRY[step.type]
          : undefined;
        const title = entry?.title ?? step.type ?? "Step";
        const selected = step.id === selectedStepId;

        return (
          <React.Fragment key={step.id}>
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm",
                selected
                  ? "border-cx-accent bg-cx-sel ring-1 ring-cx-accent"
                  : "border-cx-border hover:bg-cx-sub",
              )}
            >
              <button
                type="button"
                aria-label={`Select step ${index + 1}: ${title}`}
                aria-pressed={selected}
                onClick={() => onSelect(step.id)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cx-sub text-xs font-semibold text-cx-fg2">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-cx-fg">{title}</div>
                  <div className="truncate text-xs text-cx-muted">
                    {stepSummary(step)}
                  </div>
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => onMove(index, index - 1)}
                  className="rounded p-1 text-cx-faint hover:bg-cx-sub disabled:opacity-30"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move step ${index + 1} down`}
                  disabled={index === steps.length - 1}
                  onClick={() => onMove(index, index + 1)}
                  className="rounded p-1 text-cx-faint hover:bg-cx-sub disabled:opacity-30"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete step ${index + 1}`}
                  onClick={() => onDelete(step.id)}
                  className="rounded p-1 text-cx-faint hover:bg-cx-rose/10 hover:text-cx-rose"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <InsertSlot onPick={(type) => onInsert(index + 1, type)} />
          </React.Fragment>
        );
      })}

      <div className="pt-1">
        {showAddAtEnd ? (
          <AddStepPicker
            onPick={(type) => {
              onInsert(steps.length, type);
              setShowAddAtEnd(false);
            }}
            onClose={() => setShowAddAtEnd(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAddAtEnd(true)}
            className="w-full rounded-lg border border-dashed border-cx-border-strong py-2 text-sm font-medium text-cx-muted hover:border-cx-border-strong hover:text-cx-fg"
          >
            + Add step
          </button>
        )}
      </div>
    </div>
  );
};

export default StepList;
