import { useId } from "react";
import { useTranslation } from "react-i18next";
import { CaseList, SwitchValueField } from "./switchCases";

/** A loop edge's bounds (schema 1.10) as the form edits them. */
export interface LoopBoundsValue {
  times?: number;
  forSeconds?: number;
  until?: { value: unknown; cases: unknown[] };
}

export interface LoopBoundsFormProps {
  /** The bounds now (empty: the loop repeats until the run stops). */
  value: LoopBoundsValue;
  onChange: (next: LoopBoundsValue) => void;
  /** Why `next` cannot be written (translated), or undefined when it can:
   *  the matching control is disabled with the reason. */
  refusal?: (next: LoopBoundsValue) => string | undefined;
  /** The keys setState steps store, offered under `state`. */
  stateKeys?: readonly string[];
}

const UNTIL_DEFAULT = {
  value: { $from: "connector.status" },
  cases: ["Available"],
};

const split = (seconds: number) => ({
  h: Math.floor(seconds / 3600),
  m: Math.floor((seconds % 3600) / 60),
  s: seconds % 60,
});

const without = (
  value: LoopBoundsValue,
  key: keyof LoopBoundsValue,
): LoopBoundsValue => {
  const { [key]: _gone, ...rest } = value;
  return rest;
};

/**
 * The bounds of a Repeat block: a number of rounds, a duration (hours,
 * minutes, seconds → `forSeconds`) and an `until` built like a switch: a
 * value and the cases that end the loop (the same value field and case list
 * as the switch step; `$match` cases show as chips). Any bound may be on;
 * the first one met ends the loop.
 */
export default function LoopBoundsForm({
  value,
  onChange,
  refusal,
  stateKeys,
}: LoopBoundsFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const toggle = (
    key: keyof LoopBoundsValue,
    on: LoopBoundsValue[keyof LoopBoundsValue],
  ) => {
    const next =
      value[key] !== undefined
        ? without(value, key)
        : {
            ...value,
            [key]: on,
          };
    return { next, refused: refusal?.(next) };
  };
  const row = (
    key: keyof LoopBoundsValue,
    label: string,
    on: LoopBoundsValue[keyof LoopBoundsValue],
  ) => {
    const { next, refused } = toggle(key, on);
    return (
      <>
        <label
          className="flex items-center gap-2 text-xs font-semibold text-primary"
          title={refused}
        >
          <input
            type="checkbox"
            data-testid={`loop-bound-${key}`}
            checked={value[key] !== undefined}
            disabled={refused !== undefined}
            onChange={() => onChange(next)}
          />
          {label}
        </label>
        {refused !== undefined && (
          <p
            data-testid={`loop-bound-${key}-refusal`}
            className="pl-6 text-xs text-amber-700 dark:text-amber-400"
          >
            {refused}
          </p>
        )}
      </>
    );
  };
  const number = (
    n: number,
    label: string,
    testId: string,
    set: (n: number) => void,
    min = 0,
  ) => (
    <label className="flex items-center gap-1 text-xs text-secondary">
      <input
        type="number"
        min={min}
        step={1}
        value={n}
        aria-label={label}
        data-testid={testId}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(v) && v >= min) {
            set(Math.floor(v));
          }
        }}
        className="w-16 rounded border border-gray-300 bg-transparent px-1.5 py-0.5 text-sm dark:border-gray-600"
      />
      {label}
    </label>
  );
  const duration = split(value.forSeconds ?? 0);
  const setDuration = (part: "h" | "m" | "s", n: number) => {
    const d = { ...duration, [part]: n };
    onChange({ ...value, forSeconds: d.h * 3600 + d.m * 60 + d.s });
  };
  const until = value.until;
  const setUntil = (next: { value: unknown; cases: unknown[] }) =>
    onChange({ ...value, until: next });
  return (
    <div data-testid="loop-bounds-form" className="space-y-3">
      <div className="space-y-1.5">
        {row("times", t("scenarioEditor.loop.times"), 3)}
        {value.times !== undefined && (
          <div className="pl-6">
            {number(
              value.times,
              t("scenarioEditor.loop.timesUnit"),
              "loop-times",
              (n) => onChange({ ...value, times: n }),
              1,
            )}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        {row("forSeconds", t("scenarioEditor.loop.duration"), 3600)}
        {value.forSeconds !== undefined && (
          <div className="flex flex-wrap gap-2 pl-6">
            {number(
              duration.h,
              t("scenarioEditor.loop.hours"),
              "loop-hours",
              (n) => setDuration("h", n),
            )}
            {number(
              duration.m,
              t("scenarioEditor.loop.minutes"),
              "loop-minutes",
              (n) => setDuration("m", n),
            )}
            {number(
              duration.s,
              t("scenarioEditor.loop.seconds"),
              "loop-seconds",
              (n) => setDuration("s", n),
            )}
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        {row("until", t("scenarioEditor.loop.until"), UNTIL_DEFAULT)}
        {until && (
          <div className="space-y-2 pl-6">
            <SwitchValueField
              testId="loop-until-value"
              label={t("scenarioEditor.loop.untilValue")}
              value={until.value}
              onChange={(next) => setUntil({ ...until, value: next })}
              stateKeys={stateKeys}
              help={t("scenarioEditor.loop.untilValueHelp")}
            />
            <div
              id={`${id}-cases`}
              className="text-xs font-semibold text-primary"
            >
              {t("scenarioEditor.loop.untilCases")}
            </div>
            <CaseList
              cases={until.cases}
              testIdPrefix="loop-until"
              onSet={(index, next) =>
                setUntil({
                  ...until,
                  cases: until.cases.map((c, i) => (i === index ? next : c)),
                })
              }
              onMove={(index, to) => {
                const cases = [...until.cases];
                const [moved] = cases.splice(index, 1);
                cases.splice(to, 0, moved);
                setUntil({ ...until, cases });
              }}
              onRemove={(index) =>
                setUntil({
                  ...until,
                  cases: until.cases.filter((_, i) => i !== index),
                })
              }
            />
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() =>
                setUntil({ ...until, cases: [...until.cases, ""] })
              }
            >
              {t("scenarioEditor.switch.addCase")}
            </button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted">{t("scenarioRun.loopBounds.hint")}</p>
    </div>
  );
}
