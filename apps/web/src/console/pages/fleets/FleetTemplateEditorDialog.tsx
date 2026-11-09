import { useTranslation } from "react-i18next";
import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { FleetTemplate } from "@ocpp-cp-simulator/contracts/methods";
import { parseFleetTemplateJson } from "../../lib/fleetTemplates";

export interface FleetTemplateEditorDialogProps {
  /** The text to start from: a new template, or the one being edited. */
  initialText: string;
  /** Editing keeps the id: saving under another id would make a copy. */
  mode: "new" | "edit";
  onSave: (template: FleetTemplate) => Promise<void>;
  onClose: () => void;
}

/**
 * Edits a fleet template as the JSON a `--fleet-template` file holds. The text
 * is checked with the daemon's own schema before anything is sent; what the
 * daemon still refuses (a file template's id, say) is shown under the editor.
 */
const FleetTemplateEditorDialog: React.FC<FleetTemplateEditorDialogProps> = ({
  initialText,
  mode,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = parseFleetTemplateJson(text);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      return;
    }
    setProblems([]);
    setSaving(true);
    try {
      await onSave(parsed.template);
    } catch (error) {
      setProblems([error instanceof Error ? error.message : String(error)]);
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="w-[min(720px,calc(100vw-32px))] max-w-none gap-3 border-cx-border-strong bg-cx-card text-cx-fg sm:rounded-xl">
        <DialogTitle className="text-[15px] font-semibold tracking-normal">
          {mode === "new"
            ? t("fleets.editor.titleNew")
            : t("fleets.editor.titleEdit")}
        </DialogTitle>
        <DialogDescription className="text-[12.5px] text-cx-muted">
          {t("fleets.editor.hint")}
        </DialogDescription>
        <Textarea
          aria-label={t("fleets.editor.jsonAria")}
          spellCheck={false}
          className="min-h-[300px] font-mono text-[12px]"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {problems.length > 0 && (
          <ul
            role="alert"
            aria-label={t("fleets.editor.problems")}
            className="list-disc space-y-0.5 rounded-md border border-cx-rose/40 bg-cx-rose/10 py-2 pl-7 pr-3 text-[12.5px]"
          >
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {t("fleets.editor.cancel")}
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {t("fleets.editor.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FleetTemplateEditorDialog;
