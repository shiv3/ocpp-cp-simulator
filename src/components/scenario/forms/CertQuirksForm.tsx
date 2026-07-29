import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CERT_SIGNATURE_ALGORITHMS } from "../../../cp/application/scenario/ScenarioTypes";

const DEFAULT_MODE = "set";
const DEFAULT_CSR_KEY_ALGORITHM = "RSA";
const DEFAULT_CSR_LINE_ENDINGS = "lf";

export default function CertQuirksForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const modeOptions = [
    { value: "set", label: "Set Quirks" },
    { value: "clear", label: "Clear Quirks" },
  ];

  const presetOptions = [
    { value: "", label: "(none)" },
    { value: "octt", label: "OCTT (legacy SHA256withRSA)" },
  ];

  const csrKeyOptions = [
    { value: "ECDSA", label: "ECDSA" },
    { value: "RSA", label: "RSA" },
  ];

  const lineEndingsOptions = [
    { value: "lf", label: "LF (Unix)" },
    { value: "crlf", label: "CRLF (Windows)" },
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
    const updated = { ...value, mode };
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
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label="Mode"
        value={currentMode}
        onChange={handleModeChange}
        options={modeOptions}
      />
      {currentMode === "set" && (
        <>
          <SelectField
            label="Preset (optional)"
            value={currentPreset}
            onChange={handlePresetChange}
            options={presetOptions}
          />
          <SelectField
            label="CSR Key Algorithm (optional)"
            value={currentCsrKeyAlgorithm}
            onChange={handleCsrKeyChange}
            options={[{ value: "", label: "(none)" }, ...csrKeyOptions]}
          />
          <SelectField
            label="CSR PEM Line Endings (optional)"
            value={currentLineEndings}
            onChange={handleLineEndingsChange}
            options={[{ value: "", label: "(none)" }, ...lineEndingsOptions]}
          />
          <div>
            <label className="block text-xs font-semibold text-primary mb-1">
              Required Signature Algorithms (optional, comma-separated)
            </label>
            <input
              type="text"
              className="input-base w-full text-xs"
              placeholder="e.g., RSASSA-PKCS1-v1_5, ECDSA"
              value={currentAlgorithms.join(", ")}
              onChange={(e) => handleAlgorithmsChange(e.target.value)}
            />
            <div className="text-xs text-gray-500 mt-1">
              Valid: {algorithmOptions.map((o) => o.value).join(", ")}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-primary mb-1">
              Hidden Configuration Keys (optional, comma-separated)
            </label>
            <input
              type="text"
              className="input-base w-full text-xs"
              placeholder="e.g., CpoName, SomeOtherKey"
              value={currentHiddenKeys.join(", ")}
              onChange={(e) => handleHiddenKeysChange(e.target.value)}
            />
          </div>
        </>
      )}
    </div>
  );
}
