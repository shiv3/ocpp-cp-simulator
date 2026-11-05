import React from "react";

import { cn } from "@/lib/utils";

export interface SwitchProps {
  /** Accessible name; the visible text is `children`. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}

/**
 * An on / off switch in the mock's look: a checkbox with `role="switch"`, kept
 * in the tab order and the accessibility tree, drawn as a track and a knob.
 */
const Switch: React.FC<SwitchProps> = ({
  label,
  checked,
  onChange,
  disabled,
  title,
  className,
  children,
}) => (
  <label
    title={title}
    className={cn(
      "inline-flex cursor-pointer items-center gap-[7px] text-[12.5px] text-cx-fg2",
      disabled && "cursor-not-allowed opacity-60",
      className,
    )}
  >
    <input
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="peer sr-only"
    />
    <span
      aria-hidden
      className="relative h-4 w-7 shrink-0 rounded-full bg-cx-border-strong transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-cx-card after:transition-[left] peer-checked:bg-cx-accent peer-checked:after:left-[14px] peer-focus-visible:ring-2 peer-focus-visible:ring-cx-accent peer-focus-visible:ring-offset-1"
    />
    {children}
  </label>
);

export default Switch;
