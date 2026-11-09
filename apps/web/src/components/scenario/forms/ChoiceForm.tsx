import { useTranslation } from "react-i18next";
import { NumberField, TextField } from "./FormFields";
import { LaneLine, RowActions } from "./SelectLanes";
import { useIndexedLanes } from "./useIndexedLanes";
import type { NodeFormComponentProps, NodeFormData } from "./types";

type Option = { weight?: number; label?: string };

/** The weight the executor draws with (absent: 1), or null when it fails
 *  the run (not a number above 0). */
function effectiveWeight(option: Option): number | null {
  const weight = option.weight ?? 1;
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
  const options: Option[] = Array.isArray(value.options)
    ? (value.options as Option[])
    : [];
  const lanes = useIndexedLanes({
    items: options,
    prefix: "option",
    context,
    store: (next) => ({ ...value, options: next }),
    onChange,
  });
  const update = (index: number, patch: Option) =>
    onChange({
      ...value,
      options: options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    });
  const weights = options.map(effectiveWeight);
  const total = weights.reduce<number>((sum, w) => sum + (w ?? 0), 0);

  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
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
          {options.map((option, index) => {
            const name = `option-${index}`;
            const weight = weights[index];
            const share =
              weight !== null && weight !== undefined && total > 0
                ? weight / total
                : 0;
            return (
              <li
                key={index}
                data-testid={`choice-option-${index}`}
                className="space-y-1.5 rounded border border-gray-300 p-2 dark:border-gray-600"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-secondary">
                    {name}
                  </span>
                  <span className="flex-1" />
                  <RowActions
                    index={index}
                    count={options.length}
                    name={name}
                    onMove={(to) => lanes.move(index, to)}
                    onRemove={() => lanes.remove(index)}
                  />
                </div>
                <TextField
                  label={t("scenarioEditor.choice.optionLabel")}
                  value={option.label ?? ""}
                  onChange={(label) =>
                    update(index, { label: label === "" ? undefined : label })
                  }
                />
                <div className="flex items-end gap-2">
                  <div className="w-24 shrink-0">
                    <NumberField
                      label={t("scenarioEditor.choice.weight")}
                      value={option.weight ?? ""}
                      onChange={(w) => update(index, { weight: w })}
                      placeholder="1"
                      min={0}
                      step="any"
                    />
                  </div>
                  <div
                    className="mb-2 h-2 min-w-0 flex-1 overflow-hidden rounded bg-gray-200 dark:bg-gray-700"
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
                    className="mb-1 w-10 shrink-0 text-right font-mono text-xs text-secondary"
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
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          onClick={() => onChange({ ...value, options: [...options, {}] })}
        >
          {t("scenarioEditor.choice.add")}
        </button>
        <p className="text-xs text-muted">{t("scenarioEditor.choice.help")}</p>
      </div>
    </div>
  );
}
