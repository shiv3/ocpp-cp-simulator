import { TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** Schema 1.5 (#566): names a behavior loaded on the station. The run fails
 *  if no loaded behavior has that id. */
export default function UseBehaviorForm({
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
      <TextField
        label="Behavior id"
        value={(value.behaviorId as string | undefined) ?? ""}
        onChange={(behaviorId) => onChange({ ...value, behaviorId })}
        placeholder="e.g., my-behavior"
      />
    </div>
  );
}
