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
  /** Non-linear guard: true disables insert/move/delete/select entirely. */
  readOnly: boolean;
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
        className="flex h-4 w-full items-center justify-center rounded text-gray-300 opacity-0 hover:bg-blue-50 hover:text-blue-500 focus-visible:opacity-100 group-hover/insert:opacity-100 dark:hover:bg-blue-950"
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
  readOnly,
}) => {
  const [showAddAtEnd, setShowAddAtEnd] = useState(false);

  return (
    <div className="space-y-0.5">
      {!readOnly && <InsertSlot onPick={(type) => onInsert(0, type)} />}
      {steps.map((step, index) => {
        const entry = isScenarioNodeType(step.type)
          ? NODE_FORM_REGISTRY[step.type]
          : undefined;
        const title = entry?.title ?? step.type ?? "Step";
        const selected = step.id === selectedStepId;

        return (
          <React.Fragment key={step.id}>
            <div
              role={readOnly ? undefined : "button"}
              tabIndex={readOnly ? undefined : 0}
              onClick={readOnly ? undefined : () => onSelect(step.id)}
              onKeyDown={
                readOnly
                  ? undefined
                  : (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(step.id);
                      }
                    }
              }
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm",
                readOnly ? "cursor-default" : "cursor-pointer",
                selected
                  ? "border-blue-400 bg-blue-50 ring-1 ring-blue-400 dark:border-blue-700 dark:bg-blue-950/40"
                  : "border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900",
              )}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900 dark:text-gray-100">
                  {title}
                </div>
                <div className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {stepSummary(step)}
                </div>
              </div>
              {!readOnly && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} up`}
                    disabled={index === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMove(index, index - 1);
                    }}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move step ${index + 1} down`}
                    disabled={index === steps.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMove(index, index + 1);
                    }}
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-gray-800"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete step ${index + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(step.id);
                    }}
                    className="rounded p-1 text-gray-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            {!readOnly && (
              <InsertSlot onPick={(type) => onInsert(index + 1, type)} />
            )}
          </React.Fragment>
        );
      })}

      {!readOnly && (
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
              className="w-full rounded-lg border border-dashed border-gray-300 py-2 text-sm font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200"
            >
              + Add step
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default StepList;
