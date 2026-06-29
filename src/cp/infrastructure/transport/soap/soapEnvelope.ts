import { XMLParser } from "fast-xml-parser";
import { create } from "xmlbuilder2";

type XmlBuilder = ReturnType<typeof create>;

export const OCPP15_SOAP_NAMESPACES = {
  CS: "urn://Ocpp/Cs/2012/06/",
  CP: "urn://Ocpp/Cp/2012/06/",
  SOAP12: "http://www.w3.org/2003/05/soap-envelope",
  WSA: "http://www.w3.org/2005/08/addressing",
} as const;

export const WSA_ANONYMOUS_ADDRESS =
  "http://www.w3.org/2005/08/addressing/anonymous";

export const OCPP15_REGISTRATION_STATUSES = ["Accepted", "Rejected"] as const;
export type Ocpp15RegistrationStatus =
  (typeof OCPP15_REGISTRATION_STATUSES)[number];

export const BOOT_NOTIFICATION_REQUEST_FIELD_ORDER = [
  "chargePointVendor",
  "chargePointModel",
  "chargePointSerialNumber",
  "chargeBoxSerialNumber",
  "firmwareVersion",
  "iccid",
  "imsi",
  "meterType",
  "meterSerialNumber",
] as const;

type SoapTargetNamespace =
  | typeof OCPP15_SOAP_NAMESPACES.CS
  | typeof OCPP15_SOAP_NAMESPACES.CP;

export interface SoapOperationMetadata {
  readonly action: `/${string}`;
  readonly requestWrapper: string;
  readonly responseWrapper: string;
  readonly namespace: SoapTargetNamespace;
  readonly requestFieldOrder?: readonly string[];
  readonly responseFieldOrder?: readonly string[];
}

export type SoapPayloadValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | SoapPayloadValue[]
  | { readonly [key: string]: SoapPayloadValue };

export type SoapPayload = Record<string, SoapPayloadValue>;

export type SoapParsedValue =
  | string
  | number
  | boolean
  | null
  | SoapParsedValue[]
  | { [key: string]: SoapParsedValue };

export type SoapParsedPayload = Record<string, SoapParsedValue>;
export type SoapMessageKind = "request" | "response";

export interface BuildSoapEnvelopeOptions {
  readonly operation: SoapOperation;
  readonly kind?: SoapMessageKind;
  readonly chargeBoxIdentity: string;
  readonly messageId: string;
  readonly from: string;
  readonly to: string;
  readonly payload?: SoapPayload;
  readonly relatesTo?: string;
}

export interface ParsedSoapEnvelope {
  readonly operation: SoapOperation;
  readonly kind: SoapMessageKind;
  readonly action: string;
  readonly messageId: string;
  readonly from: string;
  readonly replyTo: string;
  readonly to: string;
  readonly relatesTo?: string;
  readonly chargeBoxIdentity?: string;
  readonly namespace: SoapTargetNamespace;
  readonly wrapper: string;
  readonly payload: SoapParsedPayload;
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0].toLowerCase() + value.slice(1);
}

function operationMetadata(
  operation: string,
  namespace: SoapTargetNamespace,
  overrides: Partial<
    Pick<SoapOperationMetadata, "requestFieldOrder" | "responseFieldOrder">
  > = {},
): SoapOperationMetadata {
  const wrapperBase = lowerFirst(operation);
  return {
    action: `/${operation}`,
    requestWrapper: `${wrapperBase}Request`,
    responseWrapper: `${wrapperBase}Response`,
    namespace,
    ...overrides,
  };
}

export const SOAP_OPERATION_METADATA = {
  Authorize: operationMetadata("Authorize", OCPP15_SOAP_NAMESPACES.CS),
  BootNotification: operationMetadata(
    "BootNotification",
    OCPP15_SOAP_NAMESPACES.CS,
    {
      requestFieldOrder: BOOT_NOTIFICATION_REQUEST_FIELD_ORDER,
      responseFieldOrder: ["status", "currentTime", "heartbeatInterval"],
    },
  ),
  DataTransfer: operationMetadata("DataTransfer", OCPP15_SOAP_NAMESPACES.CS),
  DiagnosticsStatusNotification: operationMetadata(
    "DiagnosticsStatusNotification",
    OCPP15_SOAP_NAMESPACES.CS,
  ),
  FirmwareStatusNotification: operationMetadata(
    "FirmwareStatusNotification",
    OCPP15_SOAP_NAMESPACES.CS,
  ),
  Heartbeat: operationMetadata("Heartbeat", OCPP15_SOAP_NAMESPACES.CS),
  MeterValues: operationMetadata("MeterValues", OCPP15_SOAP_NAMESPACES.CS),
  StartTransaction: operationMetadata(
    "StartTransaction",
    OCPP15_SOAP_NAMESPACES.CS,
  ),
  StatusNotification: operationMetadata(
    "StatusNotification",
    OCPP15_SOAP_NAMESPACES.CS,
  ),
  StopTransaction: operationMetadata(
    "StopTransaction",
    OCPP15_SOAP_NAMESPACES.CS,
  ),
  CancelReservation: operationMetadata(
    "CancelReservation",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  ChangeAvailability: operationMetadata(
    "ChangeAvailability",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  ChangeConfiguration: operationMetadata(
    "ChangeConfiguration",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  ClearCache: operationMetadata("ClearCache", OCPP15_SOAP_NAMESPACES.CP),
  GetConfiguration: operationMetadata(
    "GetConfiguration",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  GetDiagnostics: operationMetadata(
    "GetDiagnostics",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  GetLocalListVersion: operationMetadata(
    "GetLocalListVersion",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  RemoteStartTransaction: operationMetadata(
    "RemoteStartTransaction",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  RemoteStopTransaction: operationMetadata(
    "RemoteStopTransaction",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  ReserveNow: operationMetadata("ReserveNow", OCPP15_SOAP_NAMESPACES.CP),
  Reset: operationMetadata("Reset", OCPP15_SOAP_NAMESPACES.CP),
  SendLocalList: operationMetadata("SendLocalList", OCPP15_SOAP_NAMESPACES.CP),
  UnlockConnector: operationMetadata(
    "UnlockConnector",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
  UpdateFirmware: operationMetadata(
    "UpdateFirmware",
    OCPP15_SOAP_NAMESPACES.CP,
  ),
} as const;

export type SoapOperation = keyof typeof SOAP_OPERATION_METADATA;

const SOAP_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

const FORBIDDEN_XML_DECLARATION_PATTERN = /<!\s*(?:DOCTYPE|ENTITY)\b/i;

function targetPrefix(namespace: SoapTargetNamespace): "cs" | "cp" {
  return namespace === OCPP15_SOAP_NAMESPACES.CS ? "cs" : "cp";
}

function actionFor(
  metadata: SoapOperationMetadata,
  kind: SoapMessageKind,
): string {
  return kind === "response" ? `${metadata.action}Response` : metadata.action;
}

function orderedPayloadKeys(
  payload: SoapPayload,
  fieldOrder: readonly string[] | undefined,
): string[] {
  if (!fieldOrder) return Object.keys(payload);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of fieldOrder) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  for (const key of Object.keys(payload)) {
    if (!seen.has(key)) ordered.push(key);
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function textForPayloadValue(value: string | number | boolean | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function appendPayloadValue(
  parent: XmlBuilder,
  elementName: string,
  value: SoapPayloadValue,
  prefix: "cs" | "cp",
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      appendPayloadValue(parent, elementName, item, prefix);
    }
    return;
  }

  const child = parent.ele(`${prefix}:${elementName}`);
  if (value === null) {
    child.up();
    return;
  }
  if (isRecord(value)) {
    appendPayloadChildren(child, value as SoapPayload, undefined, prefix);
    child.up();
    return;
  }

  child.txt(textForPayloadValue(value)).up();
}

function appendPayloadChildren(
  parent: XmlBuilder,
  payload: SoapPayload,
  fieldOrder: readonly string[] | undefined,
  prefix: "cs" | "cp",
): void {
  for (const key of orderedPayloadKeys(payload, fieldOrder)) {
    appendPayloadValue(parent, key, payload[key], prefix);
  }
}

function appendWsaTextHeader(
  header: XmlBuilder,
  name: string,
  value: string,
): void {
  header.ele(`a:${name}`, { "s:mustUnderstand": "true" }).txt(value).up();
}

function appendWsaAddressHeader(
  header: XmlBuilder,
  name: string,
  address: string,
): void {
  header
    .ele(`a:${name}`, { "s:mustUnderstand": "true" })
    .ele("a:Address")
    .txt(address)
    .up()
    .up();
}

export function buildSoapEnvelope(options: BuildSoapEnvelopeOptions): string {
  const kind = options.kind ?? "request";
  const metadata = SOAP_OPERATION_METADATA[options.operation];
  const prefix = targetPrefix(metadata.namespace);
  const wrapper =
    kind === "response" ? metadata.responseWrapper : metadata.requestWrapper;

  if (kind === "response" && !options.relatesTo) {
    throw new Error("SOAP responses require relatesTo");
  }

  const envelope = create()
    .ele("s:Envelope", {
      "xmlns:s": OCPP15_SOAP_NAMESPACES.SOAP12,
      "xmlns:a": OCPP15_SOAP_NAMESPACES.WSA,
      [`xmlns:${prefix}`]: metadata.namespace,
    })
    .ele("s:Header");

  envelope
    .ele(`${prefix}:chargeBoxIdentity`)
    .txt(options.chargeBoxIdentity)
    .up();
  appendWsaTextHeader(envelope, "Action", actionFor(metadata, kind));
  appendWsaTextHeader(envelope, "MessageID", options.messageId);
  appendWsaAddressHeader(envelope, "From", options.from);
  appendWsaAddressHeader(envelope, "ReplyTo", WSA_ANONYMOUS_ADDRESS);
  appendWsaTextHeader(envelope, "To", options.to);
  if (kind === "response" && options.relatesTo) {
    appendWsaTextHeader(envelope, "RelatesTo", options.relatesTo);
  }

  const bodyWrapper = envelope.up().ele("s:Body").ele(`${prefix}:${wrapper}`);
  const payload = options.payload ?? {};
  const fieldOrder =
    kind === "response"
      ? metadata.responseFieldOrder
      : metadata.requestFieldOrder;
  appendPayloadChildren(bodyWrapper, payload, fieldOrder, prefix);

  return bodyWrapper.doc().end({ headless: true });
}

export function soapContentTypeForOperation(
  operation: SoapOperation,
  kind: SoapMessageKind = "request",
): string {
  const metadata = SOAP_OPERATION_METADATA[operation];
  return `application/soap+xml; charset=utf-8; action="${actionFor(
    metadata,
    kind,
  )}"`;
}

function elementPrefix(name: string): string {
  const separatorIndex = name.indexOf(":");
  return separatorIndex === -1 ? "" : name.slice(0, separatorIndex);
}

function localName(name: string): string {
  const separatorIndex = name.indexOf(":");
  return separatorIndex === -1 ? name : name.slice(separatorIndex + 1);
}

function isElementKey(key: string): boolean {
  return !key.startsWith("@_") && key !== "#text";
}

function namespaceBindings(
  record: Record<string, unknown>,
): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    if (key === "@_xmlns") {
      bindings[""] = value;
    } else if (key.startsWith("@_xmlns:")) {
      bindings[key.slice("@_xmlns:".length)] = value;
    }
  }
  return bindings;
}

function namespaceForElement(
  elementName: string,
  records: readonly Record<string, unknown>[],
): string | undefined {
  const prefix = elementPrefix(elementName);
  for (let i = records.length - 1; i >= 0; i--) {
    const bindings = namespaceBindings(records[i]);
    if (Object.prototype.hasOwnProperty.call(bindings, prefix)) {
      return bindings[prefix];
    }
  }
  return undefined;
}

function elementEntries(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).filter(([key]) => isElementKey(key));
}

function findElement(
  record: Record<string, unknown>,
  name: string,
): [string, unknown] | undefined {
  return elementEntries(record).find(([key]) => localName(key) === name);
}

function requireElement(
  record: Record<string, unknown>,
  name: string,
): [string, unknown] {
  const entry = findElement(record, name);
  if (!entry) throw new Error(`SOAP envelope is missing ${name}`);
  return entry;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`SOAP ${name} must be an element`);
  return value;
}

function textValue(value: unknown, name: string): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (isRecord(value)) {
    const text = value["#text"];
    if (
      typeof text === "string" ||
      typeof text === "number" ||
      typeof text === "boolean"
    ) {
      return String(text);
    }
  }
  throw new Error(`SOAP ${name} must contain text`);
}

function requireTextElement(
  record: Record<string, unknown>,
  name: string,
): { readonly key: string; readonly value: unknown; readonly text: string } {
  const [key, value] = requireElement(record, name);
  return { key, value, text: textValue(value, name) };
}

function optionalTextElement(
  record: Record<string, unknown>,
  name: string,
):
  | { readonly key: string; readonly value: unknown; readonly text: string }
  | undefined {
  const entry = findElement(record, name);
  if (!entry) return undefined;
  const [key, value] = entry;
  return { key, value, text: textValue(value, name) };
}

function requireAddressHeader(
  header: Record<string, unknown>,
  name: string,
): { readonly key: string; readonly value: unknown; readonly address: string } {
  const [key, value] = requireElement(header, name);
  const addressParent = requireRecord(value, name);
  const [, addressValue] = requireElement(addressParent, "Address");
  return { key, value, address: textValue(addressValue, `${name}.Address`) };
}

function optionalAddressHeader(
  header: Record<string, unknown>,
  name: string,
):
  | { readonly key: string; readonly value: unknown; readonly address: string }
  | undefined {
  const entry = findElement(header, name);
  if (!entry) return undefined;
  const [key, value] = entry;
  const addressParent = requireRecord(value, name);
  const [, addressValue] = requireElement(addressParent, "Address");
  return { key, value, address: textValue(addressValue, `${name}.Address`) };
}

function isParsedScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function normalizeParsedValue(value: unknown): SoapParsedValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeParsedValue(item));
  }
  if (!isRecord(value)) {
    if (isParsedScalar(value)) {
      return value;
    }
    return String(value);
  }

  const childEntries = elementEntries(value);
  if (childEntries.length === 0) {
    const text = value["#text"];
    if (
      typeof text === "string" ||
      typeof text === "number" ||
      typeof text === "boolean"
    ) {
      return String(text);
    }
    return "";
  }

  const result: Record<string, SoapParsedValue> = {};
  for (const [key, childValue] of childEntries) {
    const name = localName(key);
    const normalized = normalizeParsedValue(childValue);
    const previous = result[name];
    if (previous === undefined) {
      result[name] = normalized;
    } else if (Array.isArray(previous)) {
      previous.push(normalized);
    } else {
      result[name] = [previous, normalized];
    }
  }
  return result;
}

function payloadFromWrapper(wrapperValue: unknown): SoapParsedPayload {
  const payload = normalizeParsedValue(wrapperValue);
  return isRecord(payload) ? (payload as SoapParsedPayload) : {};
}

function findMetadataByWrapper(wrapper: string): {
  readonly operation: SoapOperation;
  readonly kind: SoapMessageKind;
  readonly metadata: SoapOperationMetadata;
} {
  for (const [operation, metadata] of Object.entries(
    SOAP_OPERATION_METADATA,
  ) as [SoapOperation, SoapOperationMetadata][]) {
    if (metadata.requestWrapper === wrapper) {
      return { operation, kind: "request", metadata };
    }
    if (metadata.responseWrapper === wrapper) {
      return { operation, kind: "response", metadata };
    }
  }
  throw new Error(`Unsupported SOAP body wrapper: ${wrapper}`);
}

function assertNamespace(
  actual: string | undefined,
  expected: string,
  description: string,
): void {
  if (actual !== expected) {
    throw new Error(`${description} namespace must be ${expected}`);
  }
}

export function parseSoapEnvelope(xml: string): ParsedSoapEnvelope {
  if (FORBIDDEN_XML_DECLARATION_PATTERN.test(xml)) {
    throw new Error("SOAP XML containing DOCTYPE or ENTITY is not supported");
  }

  const parsed = SOAP_XML_PARSER.parse(xml) as unknown;
  const document = requireRecord(parsed, "document");
  const [envelopeKey, envelopeValue] = requireElement(document, "Envelope");
  const envelope = requireRecord(envelopeValue, "Envelope");
  const envelopeNamespace = namespaceForElement(envelopeKey, [envelope]);
  assertNamespace(
    envelopeNamespace,
    OCPP15_SOAP_NAMESPACES.SOAP12,
    "SOAP Envelope",
  );

  const [, headerValue] = requireElement(envelope, "Header");
  const header = requireRecord(headerValue, "Header");
  const [, bodyValue] = requireElement(envelope, "Body");
  const body = requireRecord(bodyValue, "Body");
  const [wrapperKey, wrapperValue] = elementEntries(body)[0] ?? [];
  if (!wrapperKey)
    throw new Error("SOAP Body must contain an operation wrapper");

  const wrapper = localName(wrapperKey);
  const { operation, kind, metadata } = findMetadataByWrapper(wrapper);
  const bodyWrapper = isRecord(wrapperValue) ? wrapperValue : {};
  const bodyNamespace = namespaceForElement(wrapperKey, [
    envelope,
    body,
    bodyWrapper,
  ]);
  assertNamespace(bodyNamespace, metadata.namespace, "SOAP Body wrapper");

  const action = requireTextElement(header, "Action");
  const actionRecord = isRecord(action.value) ? action.value : {};
  assertNamespace(
    namespaceForElement(action.key, [envelope, header, actionRecord]),
    OCPP15_SOAP_NAMESPACES.WSA,
    "WS-Addressing Action",
  );
  const expectedAction = actionFor(metadata, kind);
  if (action.text !== expectedAction) {
    throw new Error(`SOAP Action must be ${expectedAction}`);
  }

  const chargeBoxIdentity =
    kind === "request"
      ? requireTextElement(header, "chargeBoxIdentity")
      : optionalTextElement(header, "chargeBoxIdentity");
  if (chargeBoxIdentity) {
    const chargeBoxRecord = isRecord(chargeBoxIdentity.value)
      ? chargeBoxIdentity.value
      : {};
    assertNamespace(
      namespaceForElement(chargeBoxIdentity.key, [
        envelope,
        header,
        chargeBoxRecord,
      ]),
      metadata.namespace,
      "chargeBoxIdentity",
    );
  }

  const messageId = requireTextElement(header, "MessageID");
  const from =
    kind === "request"
      ? requireAddressHeader(header, "From")
      : optionalAddressHeader(header, "From");
  const replyTo =
    kind === "request"
      ? requireAddressHeader(header, "ReplyTo")
      : optionalAddressHeader(header, "ReplyTo");
  const to = requireTextElement(header, "To");
  const relatesTo = findElement(header, "RelatesTo");
  const relatesToText = relatesTo
    ? textValue(relatesTo[1], "RelatesTo")
    : undefined;

  return {
    operation,
    kind,
    action: action.text,
    messageId: messageId.text,
    from: from?.address ?? "",
    replyTo: replyTo?.address ?? "",
    to: to.text,
    ...(relatesToText ? { relatesTo: relatesToText } : {}),
    ...(chargeBoxIdentity ? { chargeBoxIdentity: chargeBoxIdentity.text } : {}),
    namespace: metadata.namespace,
    wrapper,
    payload: payloadFromWrapper(wrapperValue),
  };
}
