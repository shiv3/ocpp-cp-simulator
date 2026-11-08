import { useTranslation } from "react-i18next";
import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CERT_SIGNATURE_ALGORITHMS } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

const DEFAULT_MODE = "set";
// Unset quirks must render as "(none)": defaulting the selects to a real
// value would display quirks the node does not persist or apply.
const DEFAULT_CSR_KEY_ALGORITHM = "";
const DEFAULT_CSR_LINE_ENDINGS = "";

export default function CertQuirksForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const modeOptions = [
    { value: "set", label: t("scenarioEditor.certQuirks.setQuirks") },
    { value: "clear", label: t("scenarioEditor.certQuirks.clearQuirks") },
  ];

  const presetOptions = [
    { value: "", label: t("scenarioEditor.form.none") },
    { value: "octt", label: t("scenarioEditor.certQuirks.octtPreset") },
  ];

  const csrKeyOptions = [
    { value: "", label: t("scenarioEditor.form.none") },
    { value: "ECDSA", label: "ECDSA" },
    { value: "RSA", label: "RSA" },
  ];

  const lineEndingsOptions = [
    { value: "", label: t("scenarioEditor.form.none") },
    { value: "lf", label: t("scenarioEditor.certQuirks.lineEndingsLf") },
    { value: "crlf", label: t("scenarioEditor.certQuirks.lineEndingsCrlf") },
  ];

  const algorithmOptions = CERT_SIGNATURE_ALGORITHMS.map((alg) => ({
    value: alg,
    label: alg,
  }));

  const currentMode = (value.mode as string | undefined) ?? DEFAULT_MODE;
  const currentPreset = (value.preset as string | undefined) ?? "";
  const currentCsrKeyAlgorithm =
    (value.csrKeyAlgorithm as string | undefined) ?? DEFAULT_CSR_KEY_ALGORITHM;
  const currentLineEndings =
    (value.csrPemLineEndings as string | undefined) ?? DEFAULT_CSR_LINE_ENDINGS;
  const currentAlgorithms = Array.isArray(
    value.requiredCertificateSignatureAlgorithms,
  )
    ? (value.requiredCertificateSignatureAlgorithms as string[])
    : [];
  const currentHiddenKeys = Array.isArray(value.hiddenConfigurationKeys)
    ? (value.hiddenConfigurationKeys as string[])
    : [];

  const handleModeChange = (mode: string) => {
    const updated: NodeFormData = { ...value, mode };
    if (mode === "clear") {
      // Remove mode-specific fields for clear mode
      delete updated.preset;
      delete updated.csrKeyAlgorithm;
      delete updated.csrPemLineEndings;
      delete updated.requiredCertificateSignatureAlgorithms;
      delete updated.hiddenConfigurationKeys;
    }
    onChange(updated);
  };

  const handlePresetChange = (preset: string) => {
    onChange({ ...value, preset: preset || undefined });
  };

  const handleCsrKeyChange = (algorithm: string) => {
    onChange({ ...value, csrKeyAlgorithm: algorithm || undefined });
  };

  const handleLineEndingsChange = (endings: string) => {
    onChange({ ...value, csrPemLineEndings: endings || undefined });
  };

  const handleAlgorithmsChange = (text: string) => {
    const algorithms = text
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);
    onChange({
      ...value,
      requiredCertificateSignatureAlgorithms:
        algorithms.length > 0 ? algorithms : undefined,
    });
  };

  const handleHiddenKeysChange = (text: string) => {
    const keys = text
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);
    onChange({
      ...value,
      hiddenConfigurationKeys: keys.length > 0 ? keys : undefined,
    });
  };

  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label={t("scenarioEditor.certQuirks.mode")}
        value={currentMode}
        onChange={handleModeChange}
        options={modeOptions}
      />
      {currentMode === "set" && (
        <>
          <SelectField
            label={t("scenarioEditor.certQuirks.preset")}
            value={currentPreset}
            onChange={handlePresetChange}
            options={presetOptions}
          />
          <SelectField
            label={t("scenarioEditor.certQuirks.csrKeyAlgorithm")}
            value={currentCsrKeyAlgorithm}
            onChange={handleCsrKeyChange}
            options={[
              { value: "", label: t("scenarioEditor.form.none") },
              ...csrKeyOptions,
            ]}
          />
          <SelectField
            label={t("scenarioEditor.certQuirks.csrLineEndings")}
            value={currentLineEndings}
            onChange={handleLineEndingsChange}
            options={[
              { value: "", label: t("scenarioEditor.form.none") },
              ...lineEndingsOptions,
            ]}
          />
          <div>
            <label className="block text-xs font-semibold text-primary mb-1">
              {t("scenarioEditor.certQuirks.requiredAlgorithms")}
            </label>
            <input
              type="text"
              className="input-base w-full text-xs"
              placeholder={t(
                "scenarioEditor.certQuirks.requiredAlgorithmsPlaceholder",
              )}
              value={currentAlgorithms.join(", ")}
              onChange={(e) => handleAlgorithmsChange(e.target.value)}
            />
            <div className="text-xs text-gray-500 mt-1">
              {t("scenarioEditor.certQuirks.valid", {
                values: algorithmOptions.map((o) => o.value).join(", "),
              })}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-primary mb-1">
              {t("scenarioEditor.certQuirks.hiddenKeys")}
            </label>
            <input
              type="text"
              className="input-base w-full text-xs"
              placeholder={t("scenarioEditor.certQuirks.hiddenKeysPlaceholder")}
              value={currentHiddenKeys.join(", ")}
              onChange={(e) => handleHiddenKeysChange(e.target.value)}
            />
          </div>
        </>
      )}
    </div>
  );
}
