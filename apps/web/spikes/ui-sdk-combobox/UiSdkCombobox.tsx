import {
  Autocomplete,
  AutocompleteClear,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteTrigger,
} from "@ui-sdk/react/autocomplete";

/**
 * Spike for #936: the console's free-text filter `Combobox`
 * (`apps/web/src/console/components/Combobox.tsx`) rebuilt on
 * `@ui-sdk/react`'s `Autocomplete` (the SDK's "the text is the value" control;
 * its `Combobox` selects an option and does not fit a free-text URL filter).
 *
 * Same props as the production component so a call site would not change.
 * Same Tailwind classes, copied (not imported) to keep the spike free of
 * `src/`. Nothing in `apps/web/src` imports this file.
 */
export interface SpikeOption {
  value: string;
  hint?: string;
  dot?: string;
}

export interface UiSdkComboboxProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: SpikeOption[];
  placeholder: string;
  "aria-label": string;
  clearLabel?: string;
  showOptionsLabel?: string;
  noMatchLabel?: string;
}

export function UiSdkCombobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  "aria-label": ariaLabel,
  clearLabel = "Clear",
  showOptionsLabel = "Show options",
  noMatchLabel = "No match",
}: UiSdkComboboxProps) {
  return (
    <Autocomplete
      value={value}
      onValueChange={(next) => onChange(next)}
      openOnFocus
      filter="contains"
    >
      <div className="relative">
        <AutocompleteInput
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          autoComplete="off"
          className="h-8 w-full rounded-[7px] border border-cx-border bg-cx-card pl-2.5 pr-14 text-[13px] text-cx-fg"
        />
        {value !== "" && (
          <AutocompleteClear
            aria-label={clearLabel}
            className="absolute inset-y-0 right-7 flex w-6 items-center justify-center text-cx-faint"
          >
            ×
          </AutocompleteClear>
        )}
        <AutocompleteTrigger
          aria-label={showOptionsLabel}
          className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-cx-faint"
        >
          ▾
        </AutocompleteTrigger>
      </div>
      <AutocompleteContent className="z-20 max-h-72 min-w-full overflow-auto rounded-[9px] border border-cx-border-strong bg-cx-card p-1 text-[13px]">
        <AutocompleteEmpty className="px-2 py-1.5 text-cx-faint">
          {noMatchLabel}
        </AutocompleteEmpty>
        <AutocompleteList>
          {options.map((option) => (
            <AutocompleteItem
              key={option.value}
              value={option.value}
              label={option.value}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[highlighted]:bg-cx-sub"
            >
              {option.dot && (
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${option.dot}`}
                />
              )}
              <span className="whitespace-nowrap">{option.value}</span>
              {option.hint && (
                <span className="ml-auto pl-3 font-mono text-[11px] text-cx-faint">
                  {option.hint}
                </span>
              )}
            </AutocompleteItem>
          ))}
        </AutocompleteList>
      </AutocompleteContent>
    </Autocomplete>
  );
}
