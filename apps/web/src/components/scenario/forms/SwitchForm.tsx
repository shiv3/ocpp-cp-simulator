import { useTranslation } from "react-i18next";
import { LaneLine } from "./SelectLanes";
import { CaseList, SwitchValueField } from "./switchCases";
import { useIndexedLanes } from "./useIndexedLanes";
import { LANE_ROW_FOCUS_CLASS, useLaneFocus } from "./useLaneFocus";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** Schema 1.6 (#654): goes on along `case-<n>` for the first case equal to
 *  the value, else along `default`. The cases are a list of JSON constants,
 *  each beside the lane it leads to; reordering or removing a case moves
 *  the lanes with their cases (`context.onReindex`). */
export default function SwitchForm({
  value,
  onChange,
  context,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  // Cases that are not a list (or missing) fail the run; they stay as the
  // file has them until the user replaces them.
  const casesIsList = Array.isArray(value.cases);
  const cases: unknown[] = casesIsList ? (value.cases as unknown[]) : [];
  const lanes = useIndexedLanes({
    items: cases,
    prefix: "case",
    context,
    store: (next) => ({ ...value, cases: next }),
    onChange,
  });
  const { rowProps } = useLaneFocus(context);
  const setCase = (index: number, next: unknown) =>
    onChange({
      ...value,
      cases: cases.map((c, i) => (i === index ? next : c)),
    });

  return (
    <div className="space-y-3">
      <div className="@lg:col-span-2">
        <SwitchValueField
          testId="switch-value"
          label={t("scenarioEditor.switch.value")}
          value={value.value}
          onChange={(next) => onChange({ ...value, value: next })}
          stateKeys={context?.stateKeys}
          help={t("scenarioEditor.switch.valueHelp")}
        />
      </div>
      <div className="space-y-2 @lg:col-span-2">
        <div className="text-xs font-semibold text-primary">
          {t("scenarioEditor.switch.cases")}
        </div>
        {!casesIsList && (
          <div
            data-testid="switch-cases-not-array"
            className="space-y-1.5 rounded border border-amber-400 p-2"
          >
            <p
              role="alert"
              className="text-xs text-amber-700 dark:text-amber-400"
            >
              {t("scenarioEditor.switch.casesNotArray")}
            </p>
            <pre className="overflow-x-auto font-mono text-xs text-secondary">
              {value.cases === undefined
                ? t("scenarioEditor.switch.casesMissing")
                : JSON.stringify(value.cases)}
            </pre>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => onChange({ ...value, cases: [] })}
            >
              {t("scenarioEditor.switch.replaceCases")}
            </button>
          </div>
        )}
        <CaseList
          cases={cases}
          testIdPrefix="switch"
          rowProps={(index) => rowProps(`case-${index}`)}
          onSet={setCase}
          onMove={(index, to) => lanes.move(index, to)}
          onRemove={(index) => lanes.remove(index)}
          extra={(index) => (
            <>
              <LaneLine context={context} handle={`case-${index}`} />
              {lanes.confirm(index)}
            </>
          )}
          after={
            <li
              data-testid="switch-default"
              {...rowProps("default")}
              className={`space-y-1.5 rounded border border-dashed border-gray-300 p-2 dark:border-gray-600 ${LANE_ROW_FOCUS_CLASS}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-secondary">
                  default
                </span>
                <span className="text-xs text-muted">
                  {t("scenarioEditor.switch.defaultHint")}
                </span>
              </div>
              <LaneLine context={context} handle="default" />
            </li>
          }
        />
        {lanes.addConfirm()}
        {casesIsList && (
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            onClick={() => lanes.add("")}
          >
            {t("scenarioEditor.switch.addCase")}
          </button>
        )}
        <p className="text-xs text-muted">
          {t("scenarioEditor.switch.casesHelp")}
        </p>
      </div>
    </div>
  );
}
