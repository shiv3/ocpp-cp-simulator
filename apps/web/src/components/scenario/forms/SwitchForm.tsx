import { useTranslation } from "react-i18next";
import {
  describeMatcher,
  isMatcher,
} from "@ocpp-cp-simulator/core/scenario/valueMatch";
import { ScenarioValueField } from "./ScenarioValueField";
import { LaneLine, RowActions } from "./SelectLanes";
import { useIndexedLanes } from "./useIndexedLanes";
import { jsonEqual } from "./scenarioValue";
import type { NodeFormComponentProps, NodeFormData } from "./types";

function isFromObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "$from" in value
  );
}

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
  const setCase = (index: number, next: unknown) =>
    onChange({
      ...value,
      cases: cases.map((c, i) => (i === index ? next : c)),
    });

  return (
    <div className="space-y-3">
      <div className="@lg:col-span-2">
        <ScenarioValueField
          testId="switch-value"
          label={t("scenarioEditor.switch.value")}
          value={value.value}
          onChange={(next) => onChange({ ...value, value: next })}
          stateKeys={context?.stateKeys}
          defaultFrom={
            context?.stateKeys?.[0]
              ? { root: "state", path: context.stateKeys[0] }
              : { root: "connector", path: "status" }
          }
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
        <ol className="space-y-2">
          {cases.map((item, index) => {
            const name = `case-${index}`;
            const first = cases.findIndex((c) => jsonEqual(c, item));
            return (
              <li
                key={index}
                data-testid={`switch-case-${index}`}
                className="space-y-1.5 rounded border border-gray-300 p-2 dark:border-gray-600"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-secondary">
                    {name}
                  </span>
                  <span className="flex-1" />
                  <RowActions
                    index={index}
                    count={cases.length}
                    name={name}
                    onMove={(to) => lanes.move(index, to)}
                    onRemove={() => lanes.remove(index)}
                  />
                </div>
                {isMatcher(item) ? (
                  // Schema 1.7: a "$match" case is shown, not edited here, so
                  // it round-trips unchanged; the Match editor is a later step.
                  <div
                    data-testid={`switch-case-match-${index}`}
                    className="space-y-1"
                  >
                    <code
                      title={JSON.stringify(item)}
                      className="inline-block rounded bg-gray-100 px-2 py-0.5 font-mono text-xs dark:bg-gray-800"
                    >
                      {describeMatcher(item)}
                    </code>
                    <p className="text-xs text-muted">
                      {t("scenarioEditor.switch.matchCase")}
                    </p>
                  </div>
                ) : (
                  <ScenarioValueField
                    hideLabel
                    label={t("scenarioEditor.switch.caseValue", { name })}
                    value={item}
                    allowFrom={false}
                    onChange={(next) => setCase(index, next)}
                  />
                )}
                <LaneLine context={context} handle={name} />
                {first !== index && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t("scenarioEditor.switch.duplicateCase", {
                      first: `case-${first}`,
                    })}
                  </p>
                )}
                {isFromObject(item) && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t("scenarioEditor.switch.caseFrom")}
                  </p>
                )}
                {lanes.confirm(index)}
              </li>
            );
          })}
          <li
            data-testid="switch-default"
            className="space-y-1.5 rounded border border-dashed border-gray-300 p-2 dark:border-gray-600"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-secondary">default</span>
              <span className="text-xs text-muted">
                {t("scenarioEditor.switch.defaultHint")}
              </span>
            </div>
            <LaneLine context={context} handle="default" />
          </li>
        </ol>
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
