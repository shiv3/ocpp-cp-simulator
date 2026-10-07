import React from "react";

import { cn } from "@/lib/utils";

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  options: ReadonlyArray<{
    value: T;
    label: string;
    disabled?: boolean;
    title?: string;
  }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** A row of toggle buttons where exactly one is pressed (the view switch). */
function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex gap-0.5 rounded-lg bg-cx-sub p-[3px]",
        className,
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-view={option.value}
          disabled={option.disabled}
          title={option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="rounded-md px-2.5 py-1 text-[13px] font-medium text-cx-muted hover:text-cx-fg disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-cx-card aria-pressed:text-cx-fg aria-pressed:shadow-[0_0_0_1px_var(--cx-border-strong)]"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default SegmentedControl;
