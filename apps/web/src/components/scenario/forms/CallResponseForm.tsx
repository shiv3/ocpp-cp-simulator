import {
  CheckboxField,
  JsonTextareaField,
  SelectField,
  TextField,
} from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

const KIND_OPTIONS = [
  { value: "result", label: "CALLRESULT (answer with a payload)" },
  { value: "error", label: "CALLERROR (answer with an error)" },
  { value: "none", label: "None (stay silent)" },
];

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields that describe how a CALL is answered: kind, payload for a
 *  result, errorCode and errorDescription for an error. Shared by the
 *  callResponse node and the `onBusy` group of a replacing csmsCallTrigger. */
export function CallResponseSpecFields({
  value,
  onChange,
}: {
  value: NodeFormData;
  onChange: (value: NodeFormData) => void;
}) {
  const kind =
    value.kind === "error" || value.kind === "none" ? value.kind : "result";
  return (
    <div className="space-y-3">
      <SelectField
        label="Answer"
        value={kind}
        onChange={(next) => onChange({ ...value, kind: next })}
        options={KIND_OPTIONS}
      />
      {kind === "result" && (
        <div>
          <JsonTextareaField
            label="Payload (JSON)"
            value={value.payload}
            onChange={(payload) => onChange({ ...value, payload })}
            placeholder="{}"
          />
          {value.payload !== undefined && !isJsonObject(value.payload) && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              The payload must be a JSON object. It is kept as typed, and the
              run fails on this step until it is one.
            </p>
          )}
          <p className="text-xs text-muted mt-1">
            A whole value can be taken from the CALL the branch took, for
            example {'{"$from": "call.payload.requestId"}'}.
          </p>
        </div>
      )}
      {kind === "error" && (
        <>
          <TextField
            label="Error code"
            value={(value.errorCode as string | undefined) ?? ""}
            onChange={(errorCode) => onChange({ ...value, errorCode })}
            placeholder="e.g., GenericError, NotSupported"
          />
          <TextField
            label="Error description"
            value={(value.errorDescription as string | undefined) ?? ""}
            onChange={(errorDescription) =>
              onChange({ ...value, errorDescription })
            }
          />
        </>
      )}
    </div>
  );
}

/** Schema 1.5 (#566): answers the CALL the nearest replacing csmsCallTrigger
 *  of this branch took. */
export default function CallResponseForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  return (
    <div className="space-y-3">
      <TextField
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <CallResponseSpecFields value={value} onChange={onChange} />
      <CheckboxField
        id="call-response-skip-validation"
        label="Skip schema validation (send an invalid payload on purpose)"
        checked={value.skipValidation === true}
        onChange={(skipValidation) => onChange({ ...value, skipValidation })}
      />
    </div>
  );
}
