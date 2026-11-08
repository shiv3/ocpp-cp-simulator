import { useTranslation } from "react-i18next";
import type {
  BehaviorParams,
  JsonObject,
  JsonValue,
  ParamsSchema,
} from "@ocpp-cp-sim/contracts/behavior";
import {
  CheckboxField,
  JsonTextareaField,
  NumberField,
  SelectField,
  TextField,
} from "./FormFields";

/** Translated titles of the built-in params, by "<behavior id>.<param>". */
const BUILTIN_TITLE_KEYS = {
  "default.firmware.stepMs": "scenarioEditor.params.firmware.stepMs",
  "default.firmware.failAt": "scenarioEditor.params.firmware.failAt",
  "default.firmware.startAt": "scenarioEditor.params.firmware.startAt",
  "default.signedFirmware.stepMs":
    "scenarioEditor.params.signedFirmware.stepMs",
  "default.logs.uploadMs": "scenarioEditor.params.logs.uploadMs",
  "default.reset.delayMs": "scenarioEditor.params.reset.delayMs",
  "default.unlock.outcome": "scenarioEditor.params.unlock.outcome",
} as const;

type BuiltinTitleKey = keyof typeof BUILTIN_TITLE_KEYS;

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

interface BehaviorParamsFormProps {
  behaviorId: string;
  declared: BehaviorParams;
  /** What the node sets: only the keys that differ from the defaults. */
  value: JsonObject | undefined;
  onChange: (value: JsonObject | undefined) => void;
}

/**
 * One form for every behavior: a field per property of the params schema,
 * filled from the node's params or else the defaults. A field set back to its
 * default drops the key, so the saved node holds only the deviations.
 */
export default function BehaviorParamsForm({
  behaviorId,
  declared,
  value,
  onChange,
}: BehaviorParamsFormProps) {
  const { t } = useTranslation();
  const set = value ?? {};
  const properties = declared.schema.properties ?? {};

  const update = (name: string, next: JsonValue | undefined): void => {
    const copy: Record<string, JsonValue> = { ...set };
    if (next === undefined || sameJson(next, declared.defaults[name])) {
      delete copy[name];
    } else {
      copy[name] = next;
    }
    onChange(Object.keys(copy).length > 0 ? copy : undefined);
  };

  const titleOf = (name: string, schema: ParamsSchema): string => {
    const key = `${behaviorId}.${name}` as BuiltinTitleKey;
    return Object.hasOwn(BUILTIN_TITLE_KEYS, key)
      ? t(BUILTIN_TITLE_KEYS[key])
      : (schema.title ?? name);
  };

  return (
    <div className="space-y-3" data-testid="behavior-params-form">
      {Object.entries(properties).map(([name, schema]) => {
        const current = Object.hasOwn(set, name)
          ? set[name]
          : declared.defaults[name];
        const label = titleOf(name, schema);
        const id = `${behaviorId}-${name}`;
        const strings = schema.enum?.every((o) => typeof o === "string")
          ? (schema.enum as readonly string[])
          : undefined;
        let field: React.ReactNode;
        if (strings) {
          field = (
            <SelectField
              label={label}
              value={String(current ?? strings[0])}
              onChange={(next) => update(name, next)}
              options={strings.map((option) => ({
                value: option,
                label: option,
              }))}
            />
          );
        } else if (schema.type === "boolean") {
          field = (
            <CheckboxField
              id={id}
              label={label}
              checked={current === true}
              onChange={(next) => update(name, next)}
            />
          );
        } else if (schema.type === "integer") {
          field = (
            <NumberField
              label={label}
              value={typeof current === "number" ? current : ""}
              min={schema.minimum}
              onChange={(next) => update(name, next)}
            />
          );
        } else if (schema.type === "string") {
          field = (
            <TextField
              label={label}
              value={typeof current === "string" ? current : ""}
              onChange={(next) => update(name, next)}
            />
          );
        } else {
          field = (
            <JsonTextareaField
              label={label}
              value={current}
              onChange={(next) => update(name, next as JsonValue)}
            />
          );
        }
        return (
          <div key={name} title={schema.description}>
            {field}
          </div>
        );
      })}
      {Object.keys(set).length > 0 ? (
        <button
          type="button"
          className="text-xs text-primary underline"
          onClick={() => onChange(undefined)}
        >
          {t("scenarioEditor.params.reset")}
        </button>
      ) : null}
    </div>
  );
}
