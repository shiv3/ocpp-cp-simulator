import { useT } from "../../../i18n";

export default function NoExtraConfigForm() {
  const t = useT();
  return (
    <div className="text-sm text-muted">
      {t("scenarioEditor.noExtraConfig")}
    </div>
  );
}
