import { useTranslation } from "react-i18next";
export default function NoExtraConfigForm() {
  const { t } = useTranslation();
  return (
    <div className="text-sm text-muted">
      {t("scenarioEditor.noExtraConfig")}
    </div>
  );
}
