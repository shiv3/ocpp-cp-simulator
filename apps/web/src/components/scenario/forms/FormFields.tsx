import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "../../../i18n";

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface NumberFieldProps {
  label: string;
  value: number | "";
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  min?: number;
  /** A step (e.g. "any") lets the field hold a fraction. */
  step?: number | "any";
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}

interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface TextareaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: TextFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <input
        type="text"
        className="input-base w-full text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  placeholder,
  min,
  step,
}: NumberFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <input
        type="number"
        className="input-base w-full text-sm"
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? undefined
              : step === undefined
                ? Number.parseInt(event.target.value, 10) || 0
                : Number.parseFloat(event.target.value) || 0,
          )
        }
        placeholder={placeholder}
        min={min}
        step={step}
      />
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: SelectFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <select
        className="input-base w-full text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange,
}: CheckboxFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="w-4 h-4"
      />
      <label htmlFor={id} className="text-xs font-semibold text-primary">
        {label}
      </label>
    </div>
  );
}

export function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 6,
  className = "input-base w-full font-mono text-xs",
}: TextareaFieldProps) {
  return (
    <div>
      <label className="block text-xs font-semibold text-primary mb-1">
        {label}
      </label>
      <textarea
        className={className}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

interface JsonTextareaFieldProps {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  placeholder?: string;
  /** Show an absent value as an empty field rather than `{}`. */
  optional?: boolean;
}

/** A JSON value edited as text. Text that does not parse is passed on as the
 *  raw string, so the field keeps exactly what is being typed. */
export function JsonTextareaField({
  label,
  value,
  onChange,
  placeholder,
  optional = false,
}: JsonTextareaFieldProps) {
  const text =
    typeof value === "string"
      ? value
      : value === undefined
        ? optional
          ? ""
          : "{}"
        : JSON.stringify(value, null, 2);
  return (
    <TextareaField
      label={label}
      value={text}
      onChange={(next) => {
        try {
          onChange(JSON.parse(next));
        } catch {
          onChange(next);
        }
      }}
      placeholder={placeholder}
    />
  );
}

interface JsonValueFieldProps {
  label: string;
  /** The current JSON value; `undefined` is an empty field. */
  value: unknown;
  /** Called with each value the text parses to (and `undefined` for empty
   *  text when `optional`). Text that is not valid keeps the last value. */
  onChange: (value: unknown) => void;
  placeholder?: string;
  optional?: boolean;
  /** Returns a message key when a parsed value is not acceptable. */
  validate?: (value: unknown) => MessageKey | null;
  help?: string;
  rows?: number;
}

function jsonText(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

/** Any JSON value (a string needs its quotes) edited as text. Unlike
 *  JsonTextareaField the text is a local draft, so an unparsable or rejected
 *  edit is reported next to the field instead of being stored. */
export function JsonValueField({
  label,
  value,
  onChange,
  placeholder,
  optional = false,
  validate,
  help,
  rows = 4,
}: JsonValueFieldProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => jsonText(value));
  const [error, setError] = useState<MessageKey | null>(null);

  // Follow a value changed from outside (undo, another node selected) but not
  // the echo of the draft itself.
  useEffect(() => {
    try {
      const parsed = draft.trim() === "" ? undefined : JSON.parse(draft);
      if (JSON.stringify(parsed) === JSON.stringify(value)) return;
    } catch {
      // the draft is invalid: the outside value wins only if it differs
    }
    setDraft(jsonText(value));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handle = (text: string) => {
    setDraft(text);
    if (text.trim() === "") {
      if (optional) {
        setError(null);
        onChange(undefined);
      } else {
        setError("scenarioEditor.json.invalid");
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError("scenarioEditor.json.invalid");
      return;
    }
    const rejected = validate?.(parsed) ?? null;
    setError(rejected);
    if (rejected === null) onChange(parsed);
  };

  return (
    <div>
      <TextareaField
        label={label}
        value={draft}
        onChange={handle}
        placeholder={placeholder}
        rows={rows}
      />
      {error !== null && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t(error)}
        </p>
      )}
      {help && <p className="text-xs text-muted mt-1">{help}</p>}
    </div>
  );
}
