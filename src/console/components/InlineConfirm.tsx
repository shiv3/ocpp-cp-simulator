import React, { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface InlineConfirmProps {
  /** The question, e.g. "Discard unsaved changes?". */
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirm button reads as destructive (rose). */
  danger?: boolean;
  className?: string;
}

/**
 * A question asked in the page, next to what it is about, instead of
 * `window.confirm` (which blocks the tab and cannot be styled). The confirm
 * button takes the focus so Enter answers it; Escape cancels.
 */
const InlineConfirm: React.FC<InlineConfirmProps> = ({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
  className,
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      role="alertdialog"
      aria-label={typeof message === "string" ? message : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Answer the question, not the side panel's Esc.
        event.preventDefault();
        onCancel();
      }}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm",
        danger
          ? "border-cx-rose/40 bg-cx-rose/10 text-cx-fg"
          : "border-cx-amber/40 bg-cx-amber/10 text-cx-fg",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button
        ref={confirmRef}
        type="button"
        size="sm"
        variant={danger ? "destructive" : "default"}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </div>
  );
};

export default InlineConfirm;
