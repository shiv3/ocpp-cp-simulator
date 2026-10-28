import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import LabelsEditor from "@/components/LabelsEditor";
import {
  labelMapFromRows,
  labelRowsFromMap,
  type LabelRow,
} from "@/components/chargePointConfig";
import type { Labels } from "@/protocol";

export interface CpLabelsCardProps {
  id: string;
  /** The labels the card opens with; read once, on mount. */
  labels: Labels;
  /** Replaces the labels in place (`cp.labels.set`); rejects on failure. */
  onSave: (labels: Labels) => Promise<void>;
  /** Called after a successful save and on Cancel. */
  onDone: () => void;
}

/**
 * The charge point page's Labels card (#471): relabels in place, so unlike
 * the Config form (cp.update) the charge point stays connected. The rows are
 * seeded once — a registry push while the operator types does not reset them —
 * and opening the card sends nothing. A failed save keeps the card open with
 * the rows as typed and says why.
 */
const CpLabelsCard: React.FC<CpLabelsCardProps> = ({
  id,
  labels,
  onSave,
  onDone,
}) => {
  const [rows, setRows] = useState<LabelRow[]>(() => labelRowsFromMap(labels));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleChange = (next: LabelRow[]) => {
    setRows(next);
    setError(null);
  };

  const handleSave = async () => {
    const parsed = labelMapFromRows(rows);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setIsSaving(true);
    try {
      await onSave(parsed.labels);
    } catch (err) {
      setError(
        `Failed to save labels: ${err instanceof Error ? err.message : String(err)}`,
      );
      setIsSaving(false);
      return;
    }
    onDone();
  };

  return (
    <div
      id={id}
      className="mb-4 rounded-[10px] border border-cx-border bg-cx-card p-4 shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none"
    >
      <h3 className="mb-2 text-sm font-semibold text-cx-fg">Labels</h3>
      <LabelsEditor rows={rows} onChange={handleChange} />
      {error && (
        <p role="alert" className="mt-2 text-xs text-cx-rose">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isSaving}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={isSaving}
          onClick={() => void handleSave()}
        >
          Save labels
        </Button>
      </div>
    </div>
  );
};

export default CpLabelsCard;
