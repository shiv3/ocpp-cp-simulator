import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MessageKey } from "../../../i18n";
import {
  CONSTANT_TYPES,
  type ConstantType,
  FROM_ROOTS,
  type FromRoot,
  type ValueShape,
  convertConstant,
  fromValue,
  pathAdvice,
  pathSuggestions,
  readValueShape,
} from "./scenarioValue";

export interface ScenarioValueFieldProps {
  label: string;
  /** The label is for assistive technology only (a list row). */
  hideLabel?: boolean;
  /** The JSON value; `undefined` is "not set" (with `optional`). */
  value: unknown;
  onChange: (value: unknown) => void;
  /** Offer "Read from…" (`{ "$from": ... }`). Switch cases: false. */
  allowFrom?: boolean;
  /** The constant types offered (default: all). A value of another type
   *  still shows as its own type, so nothing is lost. */
  types?: readonly ConstantType[];
  /** A number must be whole (a request id). */
  integer?: boolean;
  /** The least number allowed (a request id: 0). A `$from` is not
   *  checked: the run checks what it reads. */
  min?: number;
  /** The value may be absent: "Not set" is offered. */
  optional?: boolean;
  /** The keys setState steps store, offered under `state`. */
  stateKeys?: readonly string[];
  /** Where "Read from…" starts. */
  defaultFrom?: { root: FromRoot; path: string };
  help?: string;
  testId?: string;
}

type TypeChoice = ConstantType | "unset";

const TYPE_LABEL: Record<TypeChoice, MessageKey> = {
  text: "scenarioEditor.value.type.text",
  number: "scenarioEditor.value.type.number",
  boolean: "scenarioEditor.value.type.boolean",
  null: "scenarioEditor.value.type.null",
  json: "scenarioEditor.value.type.json",
  unset: "scenarioEditor.value.type.unset",
};

const ADVICE: Record<NonNullable<ReturnType<typeof pathAdvice>>, MessageKey> = {
  incomplete: "scenarioEditor.value.advice.incomplete",
  unknownField: "scenarioEditor.value.advice.unknownField",
  unknownStateKey: "scenarioEditor.value.advice.unknownStateKey",
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function jsonText(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

/**
 * A step's JSON value edited without writing JSON: a constant of a type
 * (text, number, true / false, null, or JSON for anything else) or "Read
 * from…" a `$from` root and path (schema 1.6). Any value round-trips: one
 * it cannot show otherwise (an object, an array, a `$from` on an unknown
 * root) is shown as JSON, unchanged until edited. Text that does not parse
 * keeps the last valid value and says so beside the field.
 */
export function ScenarioValueField({
  label,
  hideLabel = false,
  value,
  onChange,
  allowFrom = true,
  types = CONSTANT_TYPES,
  integer = false,
  min,
  optional = false,
  stateKeys = [],
  defaultFrom = { root: "connector", path: "status" },
  help,
  testId,
}: ScenarioValueFieldProps) {
  const { t } = useTranslation();
  const id = useId();
  /** JSON shows any value: once picked, it stays until the value changes
   *  from outside, even when what is typed parses to text or a number. */
  const [pinJson, setPinJson] = useState(false);
  const emitted = useRef<unknown>(value);
  const lastConstant = useRef<unknown>(undefined);
  const lastFrom = useRef<unknown>(undefined);

  const natural = readValueShape(value, allowFrom);
  const shape: ValueShape =
    pinJson && value !== undefined
      ? { mode: "constant", type: "json" }
      : natural;
  if (shape.mode === "constant") lastConstant.current = value;
  if (shape.mode === "from") lastFrom.current = value;

  // A value changed from outside (undo, another step) drops the JSON pin.
  useEffect(() => {
    if (!same(value, emitted.current)) {
      setPinJson(false);
      emitted.current = value;
    }
  }, [value]);

  const emit = (next: unknown) => {
    emitted.current = next;
    onChange(next);
  };

  const typeChoice: TypeChoice =
    shape.mode === "unset"
      ? "unset"
      : shape.mode === "constant"
        ? shape.type
        : "json";
  const typeOptions: TypeChoice[] = [
    ...(optional ? (["unset"] as const) : []),
    ...types,
  ];
  if (!typeOptions.includes(typeChoice)) typeOptions.push(typeChoice);

  const pickType = (next: TypeChoice) => {
    setPinJson(next === "json");
    if (next === "unset") return emit(undefined);
    const converted = convertConstant(value, next);
    if (next === "number" && typeof converted === "number") {
      const whole = integer ? Math.trunc(converted) : converted;
      return emit(min !== undefined && whole < min ? min : whole);
    }
    emit(converted);
  };

  const pickMode = (mode: "constant" | "from") => {
    if (mode === (shape.mode === "from" ? "from" : "constant")) return;
    setPinJson(false);
    if (mode === "from") {
      emit(lastFrom.current ?? fromValue(defaultFrom.root, defaultFrom.path));
    } else {
      const fallback =
        typeOptions[0] === "unset" ? undefined : convertConstant("", types[0]!);
      emit(
        lastConstant.current !== undefined ? lastConstant.current : fallback,
      );
    }
  };

  const inputLabel = hideLabel ? label : undefined;

  return (
    <div data-testid={testId} className="space-y-1">
      {(!hideLabel || allowFrom) && (
        <div className="flex items-center justify-between gap-2">
          <span
            id={`${id}-label`}
            className={
              hideLabel ? "sr-only" : "text-xs font-semibold text-primary"
            }
          >
            {label}
          </span>
          {allowFrom && (
            <div
              role="group"
              aria-label={t("scenarioEditor.value.source", { label })}
              className="inline-flex shrink-0 overflow-hidden rounded border border-gray-300 text-xs dark:border-gray-600"
            >
              {(["constant", "from"] as const).map((mode) => {
                const active =
                  (shape.mode === "from" ? "from" : "constant") === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => pickMode(mode)}
                    className={
                      active
                        ? "bg-blue-600 px-2 py-0.5 text-white"
                        : "px-2 py-0.5 text-secondary hover:bg-gray-100 dark:hover:bg-gray-700"
                    }
                  >
                    {t(
                      mode === "constant"
                        ? "scenarioEditor.value.constant"
                        : "scenarioEditor.value.from",
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {shape.mode === "from" ? (
        <FromInputs
          id={id}
          label={label}
          root={shape.root}
          path={shape.path}
          stateKeys={stateKeys}
          onChange={(root, path) => emit(fromValue(root, path))}
        />
      ) : (
        <div className="flex flex-wrap items-start gap-2">
          <select
            aria-label={t("scenarioEditor.value.typeOf", { label })}
            className="input-base w-28 shrink-0 text-sm"
            value={typeChoice}
            onChange={(event) => pickType(event.target.value as TypeChoice)}
          >
            {typeOptions.map((type) => (
              <option key={type} value={type}>
                {t(TYPE_LABEL[type])}
              </option>
            ))}
          </select>
          <ConstantInput
            type={typeChoice}
            value={value}
            integer={integer}
            min={min}
            ariaLabel={inputLabel ?? label}
            onChange={(next) => {
              // What is typed as JSON stays JSON, even "text" or 1.
              if (typeChoice === "json") setPinJson(true);
              emit(next);
            }}
          />
        </div>
      )}
      {help && <p className="text-xs text-muted">{help}</p>}
    </div>
  );
}

function FromInputs({
  id,
  label,
  root,
  path,
  stateKeys,
  onChange,
}: {
  id: string;
  label: string;
  root: FromRoot;
  path: string;
  stateKeys: readonly string[];
  onChange: (root: FromRoot, path: string) => void;
}) {
  const { t } = useTranslation();
  const suggestions = pathSuggestions(root, stateKeys);
  const advice = pathAdvice(root, path, stateKeys);
  const listId = `${id}-paths`;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <select
          aria-label={t("scenarioEditor.value.root", { label })}
          className="input-base w-28 shrink-0 text-sm"
          value={root}
          onChange={(event) => {
            const next = event.target.value as FromRoot;
            onChange(next, pathSuggestions(next, stateKeys)[0] ?? "");
          }}
        >
          {FROM_ROOTS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <span className="font-mono text-xs text-muted" aria-hidden>
          .
        </span>
        <input
          type="text"
          aria-label={t("scenarioEditor.value.path", { label })}
          className="input-base min-w-0 flex-1 font-mono text-sm"
          list={listId}
          value={path}
          placeholder={suggestions[0] ?? "key"}
          onChange={(event) => onChange(root, event.target.value.trim())}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {advice && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t(ADVICE[advice], {
            root,
            example: root === "call" ? "payload.requestId" : suggestions[0],
          })}
        </p>
      )}
    </div>
  );
}

function ConstantInput({
  type,
  value,
  integer,
  min,
  ariaLabel,
  onChange,
}: {
  type: TypeChoice;
  value: unknown;
  integer: boolean;
  min: number | undefined;
  ariaLabel: string;
  onChange: (value: unknown) => void;
}) {
  switch (type) {
    case "unset":
    case "null":
      return null;
    case "text":
      return (
        <input
          type="text"
          aria-label={ariaLabel}
          className="input-base min-w-0 flex-1 text-sm"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "boolean":
      return (
        <select
          aria-label={ariaLabel}
          className="input-base min-w-0 flex-1 text-sm"
          value={value === false ? "false" : "true"}
          onChange={(event) => onChange(event.target.value === "true")}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "number":
      return (
        <DraftInput
          ariaLabel={ariaLabel}
          value={value}
          format={(v) => (typeof v === "number" ? String(v) : "")}
          parse={(text) => {
            const n = text.trim() === "" ? Number.NaN : Number(text);
            if (!Number.isFinite(n)) {
              return { error: "scenarioEditor.value.numberInvalid" };
            }
            if (integer && !Number.isInteger(n)) {
              return { error: "scenarioEditor.value.integerInvalid" };
            }
            if (min !== undefined && n < min) {
              return {
                error: "scenarioEditor.value.belowMin",
                params: { min },
              };
            }
            return { value: n };
          }}
          onChange={onChange}
          inputMode="decimal"
        />
      );
    case "json":
      return (
        <DraftInput
          ariaLabel={ariaLabel}
          value={value}
          format={jsonText}
          parse={(text) => {
            try {
              return { value: JSON.parse(text) as unknown };
            } catch {
              return { error: "scenarioEditor.json.invalid" };
            }
          }}
          onChange={onChange}
          multiline
        />
      );
  }
}

function problemOf(parsed: Parsed): ParseError | null {
  return "error" in parsed ? parsed : null;
}

type ParseError = { error: MessageKey; params?: { min: number } };
type Parsed = { value: unknown } | ParseError;

/** Text kept as a local draft: what does not parse is reported beside the
 *  field and the last valid value stays stored. A stored value that does
 *  not pass (a negative request id in the file) shows as it is, with the
 *  same report, and stays until edited. */
function DraftInput({
  ariaLabel,
  value,
  format,
  parse,
  onChange,
  multiline = false,
  inputMode,
}: {
  ariaLabel: string;
  value: unknown;
  format: (value: unknown) => string;
  parse: (text: string) => Parsed;
  onChange: (value: unknown) => void;
  multiline?: boolean;
  inputMode?: "decimal";
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => format(value));
  const [error, setError] = useState<ParseError | null>(() =>
    problemOf(parse(format(value))),
  );

  // Follow a value changed from outside, not the echo of the draft.
  useEffect(() => {
    const parsed = parse(draft);
    if ("value" in parsed && same(parsed.value, value)) return;
    setDraft(format(value));
    setError(problemOf(parse(format(value))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handle = (text: string) => {
    setDraft(text);
    const parsed = parse(text);
    if ("error" in parsed) {
      setError(parsed);
      return;
    }
    setError(null);
    onChange(parsed.value);
  };

  const className = "input-base w-full text-sm";
  return (
    <div className="min-w-0 flex-1 basis-40">
      {multiline ? (
        <textarea
          aria-label={ariaLabel}
          className={`${className} font-mono text-xs`}
          rows={Math.min(6, Math.max(2, draft.split("\n").length))}
          value={draft}
          onChange={(event) => handle(event.target.value)}
        />
      ) : (
        <input
          type="text"
          inputMode={inputMode}
          aria-label={ariaLabel}
          className={className}
          value={draft}
          onChange={(event) => handle(event.target.value)}
        />
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t(error.error, error.params ?? {})}
        </p>
      )}
    </div>
  );
}
