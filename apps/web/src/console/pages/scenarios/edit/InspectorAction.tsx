import React from "react";

import { cn } from "@/lib/utils";
import { t as tNow } from "../../../../i18n";
import type { Capability } from "../../../lib/blockTree";

/** An inspector button, disabled with the reason as title when `cap`
 *  refuses (and its note in the title when it has one). */
export const InspectorAction: React.FC<{
  label: string;
  cap: Capability;
  danger?: boolean;
  onClick: () => void;
  /** Pointer or focus on / off the button (what it would affect is shown). */
  onHint?: (on: boolean) => void;
  children: React.ReactNode;
}> = ({ label, cap, danger, onClick, onHint, children }) => (
  <button
    type="button"
    aria-label={label}
    title={
      !cap.ok
        ? `${label}: ${tNow(cap.reason)}`
        : cap.note
          ? `${label} — ${tNow(cap.note)}`
          : label
    }
    disabled={!cap.ok}
    onClick={onClick}
    onPointerEnter={onHint && (() => onHint(true))}
    onPointerLeave={onHint && (() => onHint(false))}
    onFocus={onHint && (() => onHint(true))}
    onBlur={onHint && (() => onHint(false))}
    className={cn(
      "rounded p-1 text-cx-faint disabled:opacity-30",
      danger ? "hover:bg-cx-rose/10 hover:text-cx-rose" : "hover:bg-cx-sub",
    )}
  >
    {children}
  </button>
);
