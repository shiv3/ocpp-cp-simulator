import {
  type CertQuirksNodeData,
  type ConnectionTriggerNodeData,
  type ScenarioNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { NodeFormData } from "../types";
import {
  compactDefined,
  optionalNumber,
  CERT_SIGNATURE_ALGORITHMS_SET,
} from "./coerce";

function asCertQuirksMode(value: unknown): "set" | "clear" {
  return value === "clear" ? "clear" : "set";
}

function asCertQuirksPreset(value: unknown): "octt" | undefined {
  return value === "octt" ? "octt" : undefined;
}

function asCertKeyAlgorithm(value: unknown): "ECDSA" | "RSA" | undefined {
  return value === "ECDSA" || value === "RSA" ? value : undefined;
}

function asCertLineEndings(value: unknown): "lf" | "crlf" | undefined {
  return value === "lf" || value === "crlf" ? value : undefined;
}

/** Free-text entries reach this parser, and the CertificateSigned handler
 *  compares them verbatim against the leaf certificate's algorithm name —
 *  a typo would silently make the acceptance policy reject everything.
 *  Only the advertised algorithm names survive; an all-invalid list drops
 *  to undefined (no policy) rather than persisting as reject-everything. */
function parseCertAlgorithmArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const valid = value.filter(
    (v): v is string =>
      typeof v === "string" && CERT_SIGNATURE_ALGORITHMS_SET.has(v),
  );
  return valid.length > 0 ? valid : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v) => typeof v === "string");
}

export function certQuirksNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  const data = nodeData as Partial<CertQuirksNodeData>;
  return compactDefined({
    ...baseToForm(nodeData),
    mode: asCertQuirksMode(data.mode),
    preset: asCertQuirksPreset(data.preset),
    csrKeyAlgorithm: asCertKeyAlgorithm(data.csrKeyAlgorithm),
    csrPemLineEndings: asCertLineEndings(data.csrPemLineEndings),
    requiredCertificateSignatureAlgorithms:
      data.requiredCertificateSignatureAlgorithms,
    hiddenConfigurationKeys: data.hiddenConfigurationKeys,
  });
}

export function certQuirksFormToNodeData(
  formData: NodeFormData,
): CertQuirksNodeData {
  const mode = asCertQuirksMode(formData.mode);
  return compactDefined({
    ...baseFromForm(formData),
    mode,
    ...(mode === "set"
      ? {
          preset: asCertQuirksPreset(formData.preset),
          csrKeyAlgorithm: asCertKeyAlgorithm(formData.csrKeyAlgorithm),
          csrPemLineEndings: asCertLineEndings(formData.csrPemLineEndings),
          requiredCertificateSignatureAlgorithms: parseCertAlgorithmArray(
            formData.requiredCertificateSignatureAlgorithms,
          ),
          hiddenConfigurationKeys: parseStringArray(
            formData.hiddenConfigurationKeys,
          ),
        }
      : {}),
  }) as CertQuirksNodeData;
}

function asConnectionTriggerEvent(
  value: unknown,
): ConnectionTriggerNodeData["event"] {
  return value === "connected" ? "connected" : "disconnected";
}

export function connectionTriggerNodeDataToForm(
  nodeData: ScenarioNodeData,
): NodeFormData {
  return compactDefined({
    ...baseToForm(nodeData),
    event: asConnectionTriggerEvent(
      (nodeData as Partial<ConnectionTriggerNodeData>).event,
    ),
    timeout: optionalNumber(
      (nodeData as Partial<ConnectionTriggerNodeData>).timeout,
    ),
  });
}

export function connectionTriggerFormToNodeData(
  formData: NodeFormData,
): ConnectionTriggerNodeData {
  return compactDefined({
    ...baseFromForm(formData),
    event: asConnectionTriggerEvent(formData.event),
    timeout: optionalNumber(formData.timeout),
  }) as ConnectionTriggerNodeData;
}
