import { useTranslation } from "react-i18next";
import { NOTIFY_KINDS } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { SelectField } from "./FormFields";
import { ScenarioValueField } from "./ScenarioValueField";
import { NOTIFY_STATUSES, notifyKind } from "./notifyStatuses";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** Schema 1.6 (#654): sends a firmware / log / diagnostics status
 *  notification and goes on without waiting for the CSMS. */
export default function NotifyForm({
  value,
  onChange,
  context,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const kind = notifyKind(value.kind);
  const statuses = NOTIFY_STATUSES[kind];
  const status = typeof value.status === "string" ? value.status : "";
  return (
    <div className="space-y-3">
      <SelectField
        label={t("scenarioEditor.notify.kind")}
        value={kind}
        onChange={(next) => {
          const nextKind = notifyKind(next);
          onChange({
            ...value,
            kind: nextKind,
            // A status of another vocabulary does not carry over.
            status: NOTIFY_STATUSES[nextKind].includes(status)
              ? status
              : NOTIFY_STATUSES[nextKind][0],
          });
        }}
        options={NOTIFY_KINDS.map((k) => ({ value: k, label: k }))}
      />
      <SelectField
        label={t("scenarioEditor.notify.status")}
        value={statuses.includes(status) ? status : statuses[0]}
        onChange={(next) => onChange({ ...value, status: next })}
        options={statuses.map((s) => ({ value: s, label: s }))}
      />
      <ScenarioValueField
        testId="notify-request-id"
        label={t("scenarioEditor.notify.requestId")}
        value={value.requestId}
        optional
        types={["number"]}
        integer
        stateKeys={context?.stateKeys}
        defaultFrom={{ root: "call", path: "payload.requestId" }}
        onChange={(requestId) => onChange({ ...value, requestId })}
        help={
          kind === "signedFirmwareStatus"
            ? t("scenarioEditor.notify.requestIdRequired")
            : t("scenarioEditor.notify.requestIdHelp")
        }
      />
    </div>
  );
}
