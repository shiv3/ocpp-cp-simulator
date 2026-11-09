import { useTranslation } from "react-i18next";
import { NumberField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

type Option = { weight?: number; label?: string };

/** Schema 1.6 (#654): a seeded, weighted draw among the options; the run goes
 *  on along `option-<n>`. */
export default function ChoiceForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const options: Option[] = Array.isArray(value.options)
    ? (value.options as Option[])
    : [];
  const setOptions = (next: Option[]) => onChange({ ...value, options: next });
  const update = (index: number, patch: Option) =>
    setOptions(options.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <div className="text-xs font-semibold text-primary">
        {t("scenarioEditor.choice.options")}
      </div>
      {options.map((option, index) => (
        <div
          key={index}
          className="rounded border border-gray-300 dark:border-gray-600 p-2 space-y-2"
        >
          <div className="flex items-center justify-between text-xs font-mono text-secondary">
            <span>option-{index}</span>
            <button
              type="button"
              className="text-red-600 dark:text-red-400 disabled:opacity-40"
              disabled={options.length <= 2}
              onClick={() => setOptions(options.filter((_, i) => i !== index))}
            >
              {t("scenarioEditor.choice.remove")}
            </button>
          </div>
          <TextField
            label={t("scenarioEditor.choice.optionLabel")}
            value={option.label ?? ""}
            onChange={(label) =>
              update(index, { label: label === "" ? undefined : label })
            }
          />
          <NumberField
            label={t("scenarioEditor.choice.weight")}
            value={option.weight ?? ""}
            onChange={(weight) => update(index, { weight })}
            placeholder="1"
            min={0}
            step="any"
          />
          {option.weight !== undefined && !(option.weight > 0) && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {t("scenarioEditor.choice.weightInvalid")}
            </p>
          )}
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary text-xs px-2 py-1"
        onClick={() => setOptions([...options, {}])}
      >
        {t("scenarioEditor.choice.add")}
      </button>
      <p className="text-xs text-muted">{t("scenarioEditor.choice.help")}</p>
    </div>
  );
}
