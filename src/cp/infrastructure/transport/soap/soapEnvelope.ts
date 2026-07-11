import { XMLParser } from "fast-xml-parser";

import {
  OCPP15_DIALECT,
  OCPP15_SOAP_NAMESPACES,
  SOAP12_NAMESPACE,
  WSA_NAMESPACE,
  type SoapDialect,
  type SoapOperation,
} from "./dialect";

// Re-export for backward compatibility
export { OCPP15_SOAP_NAMESPACES };
export type { SoapOperation };

export const WSA_ANONYMOUS_ADDRESS =
  "http://www.w3.org/2005/08/addressing/anonymous";

export const OCPP15_REGISTRATION_STATUSES = ["Accepted", "Rejected"] as const;
export type Ocpp15RegistrationStatus =
  (typeof OCPP15_REGISTRATION_STATUSES)[number];

export interface SoapOperationMetadata {
  readonly action: `/${string}`;
  readonly requestWrapper: string;
  readonly responseWrapper: string;
  readonly namespace: string;
  /**
   * Which service the operation targets: "cs" = CentralSystemService (CP→CS),
   * "cp" = ChargePointService (CS→CP). Doubles as the wire XML prefix.
   */
  readonly target: "cs" | "cp";
  readonly requestFieldOrder?: readonly string[];
  readonly responseFieldOrder?: readonly string[];
  /**
   * When true, this operation can be sent/received in both directions (e.g. DataTransfer
   * in OCPP 1.5/1.6, which exists in both CS→CP and CP→CS with the same wrapper name
   * but different namespaces). Enables service-specific namespace selection and
   * ambiguity resolution during parsing.
   */
  readonly bidirectional?: true;
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

export interface ParsedSoapFault {
  readonly code: string;
  readonly reason: string;
  readonly detail?: SoapParsedPayload;
}

export class SoapFaultError extends Error {
  readonly fault: ParsedSoapFault;
  readonly httpStatus?: number;

  constructor(fault: ParsedSoapFault, httpStatus?: number) {
    const statusPrefix = httpStatus === undefined ? "" : `HTTP ${httpStatus} `;
    super(`${statusPrefix}SOAP Fault ${fault.code}: ${fault.reason}`);
    this.name = "SoapFaultError";
    this.fault = fault;
    this.httpStatus = httpStatus;
  }
}

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
  readonly dialect?: SoapDialect;
  /**
   * For bidirectional operations (e.g. DataTransfer), selects the service's namespace
   * and prefix ("cs" for CP→CS, "cp" for CS→CP). When unset, uses the metadata.target
   * (default to "cs" for CP→CS direction). Ignored for non-bidirectional operations.
   */
  readonly service?: "cs" | "cp";
}

export interface BuildSoapFaultEnvelopeOptions {
  readonly reason: string;
  readonly code?: "Sender" | "Receiver";
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
  readonly namespace: string;
  readonly wrapper: string;
  readonly payload: SoapParsedPayload;
}

// Re-export for backward compatibility. The 1.5 dialect defines every
// operation in the current SoapOperation union, so the full Record cast holds.
export const SOAP_OPERATION_METADATA =
  OCPP15_DIALECT.operationMetadata as Readonly<
    Record<SoapOperation, SoapOperationMetadata>
  >;

const SOAP_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

const FORBIDDEN_XML_DECLARATION_PATTERN = /<!\s*(?:DOCTYPE|ENTITY)\b/i;

// XML escaping functions for hand-rolled builder
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(attr: string): string {
  return attr
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Hand-rolled XML builder for minified output (no newlines, self-closing tags)
interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: (XmlElement | string)[];
}

function createElement(
  name: string,
  attributes: Record<string, string> = {},
): XmlElement {
  return {
    name,
    attributes,
    children: [],
  };
}

function addChild(element: XmlElement, child: XmlElement | string): void {
  element.children.push(child);
}

function renderXmlElement(element: XmlElement): string {
  const { name, attributes, children } = element;

  // Build attributes string
  let attrStr = "";
  for (const [key, value] of Object.entries(attributes)) {
    attrStr += ` ${key}="${escapeXmlAttribute(value)}"`;
  }

  // If no children, use self-closing tag
  if (children.length === 0) {
    return `<${name}${attrStr}/>`;
  }

  // Build children content
  let childrenStr = "";
  for (const child of children) {
    if (typeof child === "string") {
      childrenStr += escapeXmlText(child);
    } else {
      childrenStr += renderXmlElement(child);
    }
  }

  return `<${name}${attrStr}>${childrenStr}</${name}>`;
}

function requireOperationMetadata(
  dialect: SoapDialect,
  operation: SoapOperation,
): SoapOperationMetadata {
  const metadata = dialect.operationMetadata[operation];
  if (!metadata) {
    throw new Error(
      `SOAP operation ${operation} is not supported by the ${dialect.version} dialect`,
    );
  }
  return metadata;
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

function isPayloadScalar(
  value: unknown,
): value is string | number | boolean | Date {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date
  );
}

function payloadChildren(
  payload: Record<string, unknown>,
): SoapPayload | undefined {
  const children = Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => key !== "#text" && !key.startsWith("@_"),
    ),
  ) as SoapPayload;
  return Object.keys(children).length > 0 ? children : undefined;
}

function appendPayloadValue(
  parent: XmlElement,
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

  const child = createElement(`${prefix}:${elementName}`);

  if (value === null) {
    addChild(parent, child);
    return;
  }

  if (isRecord(value)) {
    // Add attributes
    for (const [key, attrValue] of Object.entries(value)) {
      if (!key.startsWith("@_")) continue;
      if (!isPayloadScalar(attrValue)) continue;
      child.attributes[key.slice(2)] = textForPayloadValue(attrValue);
    }

    // Add text
    const text = value["#text"];
    if (text !== undefined && isPayloadScalar(text)) {
      addChild(child, textForPayloadValue(text));
    }

    // Add children
    const children = payloadChildren(value);
    if (children) {
      appendPayloadChildren(child, children, undefined, prefix);
    }
  } else {
    // Scalar value
    addChild(child, textForPayloadValue(value));
  }

  addChild(parent, child);
}

function appendPayloadChildren(
  parent: XmlElement,
  payload: SoapPayload,
  fieldOrder: readonly string[] | undefined,
  prefix: "cs" | "cp",
): void {
  for (const key of orderedPayloadKeys(payload, fieldOrder)) {
    appendPayloadValue(parent, key, payload[key], prefix);
  }
}

export function buildSoapEnvelope(options: BuildSoapEnvelopeOptions): string {
  const dialect = options.dialect ?? OCPP15_DIALECT;
  const kind = options.kind ?? "request";
  const metadata = requireOperationMetadata(dialect, options.operation);
  // For bidirectional operations with explicit service, use the service's namespace/prefix.
  // Otherwise, use the metadata.target (default CP→CS direction).
  let prefix = metadata.target;
  let namespace = metadata.namespace;
  if (metadata.bidirectional && options.service) {
    prefix = options.service;
    namespace =
      options.service === "cp" ? dialect.namespaces.CP : dialect.namespaces.CS;
  }
  const wrapper =
    kind === "response" ? metadata.responseWrapper : metadata.requestWrapper;

  if (kind === "response" && !options.relatesTo) {
    throw new Error("SOAP responses require relatesTo");
  }

  const envelope = createElement("s:Envelope", {
    "xmlns:s": SOAP12_NAMESPACE,
    "xmlns:a": WSA_NAMESPACE,
    [`xmlns:${prefix}`]: namespace,
  });

  const header = createElement("s:Header");
  addChild(envelope, header);

  // chargeBoxIdentity
  const chargeBoxIdentityElem = createElement(`${prefix}:chargeBoxIdentity`);
  addChild(chargeBoxIdentityElem, options.chargeBoxIdentity);
  addChild(header, chargeBoxIdentityElem);

  // Action header
  const actionElem = createElement("a:Action", { "s:mustUnderstand": "true" });
  addChild(actionElem, actionFor(metadata, kind));
  addChild(header, actionElem);

  // MessageID header
  const messageIdElem = createElement("a:MessageID", {
    "s:mustUnderstand": "true",
  });
  addChild(messageIdElem, options.messageId);
  addChild(header, messageIdElem);

  // From header
  const fromElem = createElement("a:From", { "s:mustUnderstand": "true" });
  const fromAddress = createElement("a:Address");
  addChild(fromAddress, options.from);
  addChild(fromElem, fromAddress);
  addChild(header, fromElem);

  // ReplyTo header
  const replyToElem = createElement("a:ReplyTo", {
    "s:mustUnderstand": "true",
  });
  const replyToAddress = createElement("a:Address");
  addChild(replyToAddress, WSA_ANONYMOUS_ADDRESS);
  addChild(replyToElem, replyToAddress);
  addChild(header, replyToElem);

  // To header
  const toElem = createElement("a:To", { "s:mustUnderstand": "true" });
  addChild(toElem, options.to);
  addChild(header, toElem);

  // RelatesTo header (if response)
  if (kind === "response" && options.relatesTo) {
    const relatesToElem = createElement("a:RelatesTo", {
      "s:mustUnderstand": "true",
    });
    addChild(relatesToElem, options.relatesTo);
    addChild(header, relatesToElem);
  }

  // Body
  const body = createElement("s:Body");
  const bodyWrapper = createElement(`${prefix}:${wrapper}`);
  addChild(body, bodyWrapper);
  addChild(envelope, body);

  // Payload
  const payload = options.payload ?? {};
  const fieldOrder =
    kind === "response"
      ? metadata.responseFieldOrder
      : metadata.requestFieldOrder;
  appendPayloadChildren(bodyWrapper, payload, fieldOrder, prefix);

  return renderXmlElement(envelope);
}

export function buildSoapFaultEnvelope(
  options: BuildSoapFaultEnvelopeOptions,
): string {
  const code = options.code ?? "Sender";
  const reason = options.reason.length > 0 ? options.reason : "SOAP fault";

  const envelope = createElement("s:Envelope", {
    "xmlns:s": SOAP12_NAMESPACE,
  });

  const body = createElement("s:Body");
  const fault = createElement("s:Fault");
  const faultCode = createElement("s:Code");
  const faultValue = createElement("s:Value");
  addChild(faultValue, `s:${code}`);
  addChild(faultCode, faultValue);
  addChild(fault, faultCode);

  const reason_ = createElement("s:Reason");
  const reasonText = createElement("s:Text", { "xml:lang": "en" });
  addChild(reasonText, reason);
  addChild(reason_, reasonText);
  addChild(fault, reason_);

  addChild(body, fault);
  addChild(envelope, body);

  return renderXmlElement(envelope);
}

export function soapFaultContentType(): string {
  return "application/soap+xml; charset=utf-8";
}

export function soapContentTypeForOperation(
  operation: SoapOperation,
  kind: SoapMessageKind = "request",
  dialect: SoapDialect = OCPP15_DIALECT,
): string {
  const metadata = requireOperationMetadata(dialect, operation);
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

function firstXmlValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function findMetadataByWrapper(
  wrapper: string,
  namespace: string | undefined,
  dialect: SoapDialect = OCPP15_DIALECT,
): {
  readonly operation: SoapOperation;
  readonly kind: SoapMessageKind;
  readonly metadata: SoapOperationMetadata;
  readonly namespace: string;
} {
  let expectedNamespaceForWrapper: string | null = null;
  for (const [operation, metadata] of Object.entries(
    dialect.operationMetadata,
  ) as [SoapOperation, SoapOperationMetadata][]) {
    if (metadata.requestWrapper === wrapper) {
      // For bidirectional operations, allow either service's namespace.
      if (metadata.bidirectional && namespace) {
        const isCorrectNamespace = namespace === metadata.namespace;
        const isOppositeNamespace =
          namespace ===
          (metadata.target === "cs"
            ? dialect.namespaces.CP
            : dialect.namespaces.CS);
        if (isCorrectNamespace || isOppositeNamespace) {
          return { operation, kind: "request", metadata, namespace };
        }
      } else if (!namespace || namespace === metadata.namespace) {
        return {
          operation,
          kind: "request",
          metadata,
          namespace: metadata.namespace,
        };
      }
      expectedNamespaceForWrapper = metadata.namespace;
    }
    if (metadata.responseWrapper === wrapper) {
      // Responses should use the metadata's namespace; bidirectional doesn't affect responses.
      if (!namespace || namespace === metadata.namespace) {
        return {
          operation,
          kind: "response",
          metadata,
          namespace: metadata.namespace,
        };
      }
      expectedNamespaceForWrapper = metadata.namespace;
    }
  }
  if (expectedNamespaceForWrapper) {
    // The wrapper is a known operation of this dialect, but arrived in the
    // wrong namespace (e.g. a 1.5-namespace Reset posted to a 1.2 CP).
    throw new Error(
      `SOAP Body wrapper namespace must be ${expectedNamespaceForWrapper}`,
    );
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

export function parseSoapEnvelope(
  xml: string,
  dialect: SoapDialect = OCPP15_DIALECT,
): ParsedSoapEnvelope {
  if (FORBIDDEN_XML_DECLARATION_PATTERN.test(xml)) {
    throw new Error("SOAP XML containing DOCTYPE or ENTITY is not supported");
  }

  const parsed = SOAP_XML_PARSER.parse(xml) as unknown;
  const document = requireRecord(parsed, "document");
  const [envelopeKey, envelopeValue] = requireElement(document, "Envelope");
  const envelope = requireRecord(envelopeValue, "Envelope");
  const envelopeNamespace = namespaceForElement(envelopeKey, [envelope]);
  assertNamespace(envelopeNamespace, SOAP12_NAMESPACE, "SOAP Envelope");

  const [, headerValue] = requireElement(envelope, "Header");
  const header = requireRecord(headerValue, "Header");
  const [, bodyValue] = requireElement(envelope, "Body");
  const body = requireRecord(bodyValue, "Body");
  const [wrapperKey, wrapperValue] = elementEntries(body)[0] ?? [];
  if (!wrapperKey)
    throw new Error("SOAP Body must contain an operation wrapper");

  const wrapper = localName(wrapperKey);
  const bodyWrapper = isRecord(wrapperValue) ? wrapperValue : {};
  const bodyNamespace = namespaceForElement(wrapperKey, [
    envelope,
    body,
    bodyWrapper,
  ]);
  const { operation, kind, metadata, namespace } = findMetadataByWrapper(
    wrapper,
    bodyNamespace,
    dialect,
  );

  const action = requireTextElement(header, "Action");
  const actionRecord = isRecord(action.value) ? action.value : {};
  assertNamespace(
    namespaceForElement(action.key, [envelope, header, actionRecord]),
    WSA_NAMESPACE,
    "WS-Addressing Action",
  );
  const expectedAction = actionFor(metadata, kind);
  // The wsa:Action may be the bare "/<Operation>[Response]" the simulator
  // emits, or a fully-qualified URI that real OCA WSDL servers use, e.g.
  // SteVe's "urn://Ocpp/Cs/2010/08/CentralSystemService/BootNotificationResponse".
  // Match on the trailing "/<Operation>[Response]" segment either way (the
  // leading slash prevents suffix collisions like "/Reset" vs "/HardReset").
  if (action.text !== expectedAction && !action.text.endsWith(expectedAction)) {
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
      namespace,
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
    namespace,
    wrapper,
    payload: payloadFromWrapper(wrapperValue),
  };
}

export function parseSoapFaultEnvelope(xml: string): ParsedSoapFault | null {
  if (FORBIDDEN_XML_DECLARATION_PATTERN.test(xml)) {
    throw new Error("SOAP XML containing DOCTYPE or ENTITY is not supported");
  }

  const parsed = SOAP_XML_PARSER.parse(xml) as unknown;
  const document = requireRecord(parsed, "document");
  const [envelopeKey, envelopeValue] = requireElement(document, "Envelope");
  const envelope = requireRecord(envelopeValue, "Envelope");
  const envelopeNamespace = namespaceForElement(envelopeKey, [envelope]);
  assertNamespace(envelopeNamespace, SOAP12_NAMESPACE, "SOAP Envelope");

  const [, bodyValue] = requireElement(envelope, "Body");
  const body = requireRecord(bodyValue, "Body");
  const [wrapperKey, wrapperValue] = elementEntries(body)[0] ?? [];
  if (!wrapperKey) {
    throw new Error("SOAP Body must contain an operation wrapper");
  }
  if (localName(wrapperKey) !== "Fault") return null;

  const fault = requireRecord(wrapperValue, "Fault");
  const faultNamespace = namespaceForElement(wrapperKey, [
    envelope,
    body,
    fault,
  ]);
  assertNamespace(faultNamespace, SOAP12_NAMESPACE, "SOAP Fault");

  return {
    code: soapFaultCode(fault),
    reason: soapFaultReason(fault),
    ...soapFaultDetail(fault),
  };
}

function soapFaultCode(fault: Record<string, unknown>): string {
  const [, codeValue] = requireElement(fault, "Code");
  const code = requireRecord(firstXmlValue(codeValue), "Fault.Code");
  const [, value] = requireElement(code, "Value");
  return textValue(firstXmlValue(value), "Fault.Code.Value");
}

function soapFaultReason(fault: Record<string, unknown>): string {
  const [, reasonValue] = requireElement(fault, "Reason");
  const reason = requireRecord(firstXmlValue(reasonValue), "Fault.Reason");
  const [, text] = requireElement(reason, "Text");
  return textValue(firstXmlValue(text), "Fault.Reason.Text");
}

function soapFaultDetail(
  fault: Record<string, unknown>,
): Pick<ParsedSoapFault, "detail"> {
  const detailEntry = findElement(fault, "Detail");
  if (!detailEntry) return {};
  const detail = normalizeParsedValue(firstXmlValue(detailEntry[1]));
  if (isRecord(detail)) {
    return { detail: detail as SoapParsedPayload };
  }
  return { detail: { value: detail } };
}
