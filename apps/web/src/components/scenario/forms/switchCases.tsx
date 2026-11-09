import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  describeMatcher,
  isMatcher,
} from "@ocpp-cp-simulator/core/scenario/valueMatch";
import { ScenarioValueField } from "./ScenarioValueField";
import { RowActions } from "./SelectLanes";
import { jsonEqual } from "./scenarioValue";

/**
 * The pieces of a `switch` (schema 1.6 / 1.7) the editor shows wherever a
 * value is matched against cases: the switch step itself and a loop edge's
 * `until` (schema 1.10), which reads `value` and `cases` exactly as a switch
 * does.
 */

function isFromObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "$from" in value
  );
}

/** The value a switch matches: a `$from` reference (by default) or a
 *  constant. */
export function SwitchValueField({
  value,
  onChange,
  stateKeys,
  testId,
  label,
  help,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  stateKeys?: readonly string[];
  testId: string;
  label: string;
  help?: string;
}) {
  return (
    <ScenarioValueField
      testId={testId}
      label={label}
      value={value}
      onChange={onChange}
      stateKeys={stateKeys}
      defaultFrom={
        stateKeys?.[0]
          ? { root: "state", path: stateKeys[0] }
          : { root: "connector", path: "status" }
      }
      help={help}
    />
  );
}

/** A case as a chip: `{ "$match": … }` described (`≥ 80`, `in A|B`), a
 *  constant as JSON. */
export function CaseChip({ item }: { item: unknown }) {
  return (
    <code
      title={JSON.stringify(item)}
      className="inline-block rounded bg-gray-100 px-2 py-0.5 font-mono text-xs dark:bg-gray-800"
    >
      {isMatcher(item) ? describeMatcher(item) : JSON.stringify(item)}
    </code>
  );
}

/**
 * The cases of a switch, one row each: its name, move / remove buttons, the
 * value (a `$match` case is shown as a chip, not edited, so it round-trips
 * unchanged) and the warnings a switch gives (a case equal to an earlier
 * one, a `$from` in a case). `extra(index)` adds to a row (a switch: the
 * lane it leads to); `after` closes the list (a switch: its default row).
 */
export function CaseList({
  cases,
  onSet,
  onMove,
  onRemove,
  testIdPrefix,
  extra,
  after,
}: {
  cases: readonly unknown[];
  onSet: (index: number, value: unknown) => void;
  onMove: (index: number, to: number) => void;
  onRemove: (index: number) => void;
  testIdPrefix: string;
  extra?: (index: number) => ReactNode;
  after?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-2">
      {cases.map((item, index) => {
        const name = `case-${index}`;
        const first = cases.findIndex((c) => jsonEqual(c, item));
        return (
          <li
            key={index}
            data-testid={`${testIdPrefix}-case-${index}`}
            className="space-y-1.5 rounded border border-gray-300 p-2 dark:border-gray-600"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-secondary">{name}</span>
              <span className="flex-1" />
              <RowActions
                index={index}
                count={cases.length}
                name={name}
                onMove={(to) => onMove(index, to)}
                onRemove={() => onRemove(index)}
              />
            </div>
            {isMatcher(item) ? (
              // Schema 1.7: a "$match" case is shown, not edited here, so it
              // round-trips unchanged; the Match editor is a later step.
              <div
                data-testid={`${testIdPrefix}-case-match-${index}`}
                className="space-y-1"
              >
                <CaseChip item={item} />
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
                onChange={(next) => onSet(index, next)}
              />
            )}
            {extra?.(index)}
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
          </li>
        );
      })}
      {after}
    </ol>
  );
}
