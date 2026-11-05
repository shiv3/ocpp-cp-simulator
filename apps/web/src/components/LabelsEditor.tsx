import React from "react";
import { Plus, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { LabelRow } from "./chargePointConfig";

export interface LabelsEditorProps {
  rows: readonly LabelRow[];
  onChange: (rows: LabelRow[]) => void;
}

/**
 * Key/value rows for the charge point's labels (#446). Rows may be incomplete
 * while typed; the caller validates them on Save with `labelMapFromRows`.
 * Used by the Add form and by the charge point page's Labels card (#471).
 */
const LabelsEditor: React.FC<LabelsEditorProps> = ({ rows, onChange }) => {
  const setRow = (index: number, patch: Partial<LabelRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            type="text"
            aria-label={`Label ${index + 1} key`}
            placeholder="key, e.g. site"
            value={row.key}
            onChange={(e) => setRow(index, { key: e.target.value })}
            className="font-mono"
            spellCheck={false}
          />
          <Input
            type="text"
            aria-label={`Label ${index + 1} value`}
            placeholder="value"
            value={row.value}
            onChange={(e) => setRow(index, { value: e.target.value })}
            spellCheck={false}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            aria-label={`Remove label ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus className="mr-1 h-4 w-4" />
        Add label
      </Button>
      <p className="mt-1 text-xs text-cx-muted">
        Group charge points by site, tenant, environment… The dashboard filter
        and the cp.list API select on them.
      </p>
    </div>
  );
};

export default LabelsEditor;
