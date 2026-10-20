import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { FILTER_INPUT_CLASS } from "./filterStyles";

export interface ComboboxOption {
  value: string;
  /** Muted mono text at the right of the option (a version, a location). */
  hint?: string;
  /** Tailwind `bg-*` class of a small dot before the value (a status). */
  dot?: string;
}

export interface ComboboxProps {
  id: string;
  /** The text in the box; the owner keeps it (the list's filters are URL state). */
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder: string;
  "aria-label": string;
  className?: string;
}

/**
 * A text box with a list of suggestions, for the filters that take free text
 * but have a known set of good values. Typing narrows the list and reports
 * the text at once (the list below it filters live), picking an option sets
 * the text. A native `<datalist>` was not enough: it cannot show a status dot
 * or a hint, and its look and behavior differ per browser.
 */
const Combobox: React.FC<ComboboxProps> = ({
  id,
  value,
  onChange,
  options,
  placeholder,
  "aria-label": ariaLabel,
  className,
}) => {
  const listId = `${useId()}-${id}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // The chevron asks for every option, whatever the box holds.
  const [showAll, setShowAll] = useState(false);

  // pointerdown rather than blur: a click on an option must land before the
  // list goes away, and Safari does not focus a button on click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const visible = useMemo(() => {
    const everything =
      showAll || value === "" || options.some((o) => o.value === value);
    if (everything) return options;
    const needle = value.toLowerCase();
    return options.filter((o) => o.value.toLowerCase().includes(needle));
  }, [options, value, showAll]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setShowAll(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && open) {
      // Ours while the list is open: the side panel's Esc must not also fire.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && visible.length > 0) pick(visible[0].value);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (event.key === "ArrowDown" && !open) {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setShowAll(false);
          setOpen(true);
        }}
        onFocus={() => {
          setShowAll(false);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        className={cn(FILTER_INPUT_CLASS, "w-full pr-8")}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Show options"
        onClick={() => {
          if (open && showAll) {
            setOpen(false);
          } else {
            setShowAll(true);
            setOpen(true);
          }
        }}
        className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-cx-faint hover:text-cx-fg2"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
          className="absolute left-0 top-full z-20 mt-1 max-h-72 min-w-full overflow-auto rounded-[9px] border border-cx-border-strong bg-cx-card p-1 text-[13px] shadow-[0_10px_28px_rgba(0,0,0,0.22)]"
        >
          {value !== "" && (
            <OptionButton onSelect={() => pick("")}>
              <span className="text-cx-muted">Clear</span>
            </OptionButton>
          )}
          {visible.map((option) => (
            <OptionButton
              key={option.value}
              selected={option.value === value}
              onSelect={() => pick(option.value)}
            >
              {option.dot && (
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", option.dot)}
                />
              )}
              <span className="whitespace-nowrap text-cx-fg2">
                {option.value}
              </span>
              {option.hint && (
                <span className="ml-auto pl-3 font-mono text-[11px] text-cx-faint">
                  {option.hint}
                </span>
              )}
            </OptionButton>
          ))}
          {visible.length === 0 && (
            <div className="px-2 py-1.5 text-cx-faint">No match</div>
          )}
        </div>
      )}
    </div>
  );
};

const OptionButton: React.FC<{
  selected?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}> = ({ selected, onSelect, children }) => (
  <button
    type="button"
    role="option"
    aria-selected={selected ?? false}
    onClick={onSelect}
    className={cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-cx-sub",
      selected && "bg-cx-sub",
    )}
  >
    {children}
  </button>
);

export default Combobox;
