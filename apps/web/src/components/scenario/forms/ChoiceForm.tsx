import { useTranslation } from "react-i18next";
import { useId } from "react";
import { LaneLine, RowActions } from "./SelectLanes";
import { useIndexedLanes } from "./useIndexedLanes";
import { LANE_ROW_FOCUS_CLASS, useLaneFocus } from "./useLaneFocus";
import type { NodeFormComponentProps, NodeFormData } from "./types";

type Option = { weight?: number; label?: string };

/** An option as the file may hold it: an object, or anything else (null, a
 *  number), which the executor reads as an option without fields. */
type Entry = Option | null | undefined | string | number | boolean | unknown[];

function isOption(entry: Entry): entry is Option {
  return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

/** The weight the executor draws with (`option?.weight ?? 1`: absent, or
 *  an entry that is not an object, is 1), or null when it fails the run
 *  (not a number above 0). */
function effectiveWeight(entry: Entry): number | null {
  const weight = isOption(entry) ? (entry.weight ?? 1) : 1;
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0
    ? weight
    : null;
}

/** Schema 1.6 (#654): a seeded, weighted draw among the options; the run goes
 *  on along `option-<n>`. Each option shows its share of the draw and the
 *  lane it leads to; reordering or removing one moves the lanes with their
 *  options (`context.onReindex`). */
export default function ChoiceForm({
  value,
  onChange,
  context,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const id = useId();
  const options: Entry[] = Array.isArray(value.options)
    ? (value.options as Entry[])
    : [];
  const lanes = useIndexedLanes({
    items: options,
    prefix: "option",
    context,
    store: (next) => ({ ...value, options: next }),
    onChange,
  });
  const { rowProps } = useLaneFocus(context);
  const update = (index: number, patch: Option) =>
    onChange({
      ...value,
      options: options.map((o, i) =>
        i === index ? { ...(isOption(o) ? o : {}), ...patch } : o,
      ),
    });
  const weights = options.map(effectiveWeight);
  const total = weights.reduce<number>((sum, w) => sum + (w ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="space-y-2 @lg:col-span-2">
        <div className="text-xs font-semibold text-primary">
          {t("scenarioEditor.choice.options")}
        </div>
        {options.length < 2 && (
          <p
            role="alert"
            className="text-xs text-amber-700 dark:text-amber-400"
          >
            {t("scenarioEditor.choice.tooFew")}
          </p>
        )}
        <ol className="space-y-2">
          {options.map((entry, index) => {
            const name = `option-${index}`;
            const invalid = !isOption(entry);
            const option: Option = isOption(entry) ? entry : {};
            const weight = weights[index];
            const share =
              weight !== null && weight !== undefined && total > 0
                ? weight / total
                : 0;
            return (
              <li
                key={index}
                data-testid={`choice-option-${index}`}
                {...rowProps(name)}
                className={`space-y-1.5 rounded border border-gray-300 p-2 dark:border-gray-600 ${LANE_ROW_FOCUS_CLASS}`}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-mono text-xs text-secondary">
                    {name}
                  </span>
                  {invalid ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-amber-700 dark:text-amber-400">
                      {JSON.stringify(entry) ?? "undefined"}
                    </span>
                  ) : (
                    <input
                      type="text"
                      aria-label={t("scenarioEditor.choice.optionLabelOf", {
                        name,
                      })}
                      placeholder={t("scenarioEditor.choice.optionLabel")}
                      className="input-base min-w-0 flex-1 text-sm"
                      value={option.label ?? ""}
                      onChange={(event) =>
                        update(index, {
                          label:
                            event.target.value === ""
                              ? undefined
                              : event.target.value,
                        })
                      }
                    />
                  )}
                  <RowActions
                    index={index}
                    count={options.length}
                    name={name}
                    onMove={(to) => lanes.move(index, to)}
                    onRemove={() => lanes.remove(index)}
                  />
                </div>
                {invalid && (
                  <div className="space-y-1">
                    <p
                      role="alert"
                      className="text-xs text-amber-700 dark:text-amber-400"
                    >
                      {t("scenarioEditor.choice.optionNotObject", {
                        name,
                        value: JSON.stringify(entry) ?? "undefined",
                      })}
                    </p>
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-xs"
                      onClick={() => update(index, {})}
                    >
                      {t("scenarioEditor.choice.replaceOption")}
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`${id}-weight-${index}`}
                    className="shrink-0 text-xs font-semibold text-primary"
                  >
                    {t("scenarioEditor.choice.weight")}
                  </label>
                  <input
                    id={`${id}-weight-${index}`}
                    disabled={invalid}
                    type="number"
                    className="input-base w-20 shrink-0 text-sm"
                    value={option.weight ?? ""}
                    placeholder="1"
                    min={0}
                    step="any"
                    onChange={(event) =>
                      update(index, {
                        weight:
                          event.target.value === ""
                            ? undefined
                            : Number.parseFloat(event.target.value) || 0,
                      })
                    }
                  />
                  <div
                    className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-gray-200 dark:bg-gray-700"
                    role="img"
                    aria-label={t("scenarioEditor.choice.share", {
                      percent: Math.round(share * 100),
                    })}
                  >
                    <div
                      className="h-full bg-blue-500"
                      style={{ width: `${share * 100}%` }}
                    />
                  </div>
                  <span
                    data-testid={`choice-share-${index}`}
                    className="w-10 shrink-0 text-right font-mono text-xs text-secondary"
                  >
                    {Math.round(share * 100)}%
                  </span>
                </div>
                {weight === null && (
                  <p
                    role="alert"
                    className="text-xs text-red-600 dark:text-red-400"
                  >
                    {t("scenarioEditor.choice.weightInvalid")}
                  </p>
                )}
                <LaneLine context={context} handle={name} />
                {lanes.confirm(index)}
              </li>
            );
          })}
        </ol>
        {lanes.addConfirm()}
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          onClick={() => lanes.add({})}
        >
          {t("scenarioEditor.choice.add")}
        </button>
        <p className="text-xs text-muted">{t("scenarioEditor.choice.help")}</p>
      </div>
    </div>
  );
}
